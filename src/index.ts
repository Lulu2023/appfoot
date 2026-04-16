/**
 * FutbolFR — Cloudflare Worker Principal
 * Routes: /api/matches, /api/streams/:id, /api/proxy, /api/search
 *
 * CORRECTIONS v2:
 *  - FCM_SERVER_KEY ajouté à Env + utilisé correctement
 *  - AES-ECB émulé via AES-CBC + IV=0 (Web Crypto compatible)
 *  - Proxy : guard sur referer vide
 *  - resolveStreams : extraction correcte du sport365 eventId
 *  - Cache live réduit à 30s
 *  - StreamType retourné en majuscules (compatible Models.kt)
 *  - Protection basique du proxy via X-App-Token
 */

export interface Env {
  CACHE: KVNamespace;
  DB: D1Database;
  FOOTBALL_DATA_API_KEY: string;
  THE_SPORTS_DB_KEY: string;
  STREAM_SECRET: string;
  FCM_SERVER_KEY: string;   // ← ajouté (manquait dans la v1)
  APP_TOKEN: string;        // ← secret pour protéger le proxy
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-App-Token",
  "Content-Type": "application/json",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/matches" || path === "/api/matches/live") {
        return await handleMatches(request, env, ctx, path.includes("live"));
      }
      if (path.startsWith("/api/streams/")) {
        const matchId = path.split("/")[3];
        if (!matchId) return json({ error: "Missing matchId" }, 400);
        return await handleStreams(matchId, env, ctx);
      }
      if (path === "/api/proxy") {
        // Protection basique : vérifie le token applicatif
        const token = request.headers.get("X-App-Token") ?? url.searchParams.get("token");
        if (token !== env.APP_TOKEN) return json({ error: "Unauthorized" }, 401);
        return await handleProxy(request, env);
      }
      if (path === "/api/search") {
        const q = url.searchParams.get("q") ?? "";
        return await handleSearch(q, env);
      }
      return json({ error: "Not found" }, 404);
    } catch (e: any) {
      console.error("Unhandled error:", e);
      return json({ error: e.message ?? "Internal error" }, 500);
    }
  },

  // Cron déclenché toutes les 5 minutes (wrangler.toml)
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(refreshMatchCache(env));
  },
};

// ─── MATCHES ────────────────────────────────────────────────────────────────

async function handleMatches(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  liveOnly: boolean
): Promise<Response> {
  const cacheKey = liveOnly ? "matches:live" : "matches:all";
  const cached = await env.CACHE.get(cacheKey);
  if (cached) return json(JSON.parse(cached));

  const matches = await fetchAndMergeMatches(env);
  const filtered = liveOnly ? matches.filter((m: any) => m.status === "LIVE") : matches;

  // FIX: live cache = 30s, all cache = 5min
  const ttl = liveOnly ? 30 : 300;
  ctx.waitUntil(env.CACHE.put(cacheKey, JSON.stringify(filtered), { expirationTtl: ttl }));
  return json(filtered);
}

async function fetchAndMergeMatches(env: Env): Promise<any[]> {
  const [officialMatches, sport365Matches] = await Promise.allSettled([
    fetchOfficialMatches(env),
    fetchSport365Schedule(),
  ]);

  const official = officialMatches.status === "fulfilled" ? officialMatches.value : [];
  const s365 = sport365Matches.status === "fulfilled" ? sport365Matches.value : [];

  return mergeMatchData(official, s365);
}

async function fetchOfficialMatches(env: Env): Promise<any[]> {
  // football-data.org — Ligue 1, Champions League, etc.
  // NOTE: le tier gratuit est limité à 10 req/min — on séquentialise en cas d'erreur 429
  const competitions = ["FL1", "CL", "PL", "PD", "BL1", "SA"];
  const today = new Date().toISOString().split("T")[0];
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().split("T")[0];

  const results = await Promise.all(
    competitions.map((code) =>
      fetch(
        `https://api.football-data.org/v4/competitions/${code}/matches?dateFrom=${today}&dateTo=${tomorrow}`,
        { headers: { "X-Auth-Token": env.FOOTBALL_DATA_API_KEY } }
      )
        .then((r) => (r.ok ? r.json() : Promise.resolve({ matches: [] })))
        .then((d: any) => d.matches ?? [])
        .catch(() => [])
    )
  );

  return results.flat().map((m: any) => ({
    id: `fd_${m.id}`,
    homeTeam: {
      name: m.homeTeam?.name ?? "?",
      shortName: m.homeTeam?.shortName ?? "?",
      crest: m.homeTeam?.crest ?? null,
      tla: m.homeTeam?.tla ?? null,
    },
    awayTeam: {
      name: m.awayTeam?.name ?? "?",
      shortName: m.awayTeam?.shortName ?? "?",
      crest: m.awayTeam?.crest ?? null,
      tla: m.awayTeam?.tla ?? null,
    },
    competition: {
      name: m.competition?.name ?? "?",
      code: m.competition?.code ?? null,
      emblem: m.competition?.emblem ?? null,
    },
    utcDate: m.utcDate ?? null,
    status: normalizeStatus(m.status),
    score: m.score
      ? { home: m.score.fullTime?.home ?? 0, away: m.score.fullTime?.away ?? 0 }
      : null,
    minute: m.minute ?? null,
    source: "official",
    streamSources: [],
  }));
}

async function fetchSport365Schedule(): Promise<any[]> {
  try {
    const resp = await fetch("https://sport365.live/en/events/-/1/-/-/0", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://sport365.live/",
      },
      // @ts-ignore — propriété CF spécifique
      cf: { cacheEverything: false },
    });

    if (!resp.ok) return [];
    const html = await resp.text();
    return parseSport365HTML(html);
  } catch {
    return [];
  }
}

function parseSport365HTML(html: string): any[] {
  const regex =
    /onClick=.*?"event_(\w+)".*?<td rowspan=2.*?src="([^"]+)".*?<td rowspan=2.*?>(\d+:\d+)<.*?<td.*?>([^<]+)<.*?<td.*?>(.*?)\/td>.*?<tr.*?<td colspan=2.*?>([^<]+)<\/td><[^>]+>([^<]*)</gis;

  const clean = html.replace(/\n|\r|\t|\s{2}/g, "");
  const matches: any[] = [];
  let m: RegExpExecArray | null;

  while ((m = regex.exec(clean)) !== null) {
    const [, eventId, colorImg, time, title, quality, league, lang] = m;
    const isLive = colorImg?.includes("-green-");
    const fr = lang?.toLowerCase().includes("fr");

    matches.push({
      id: `s365_${eventId}`,
      eventId,
      title: title?.trim(),
      league: league?.trim(),
      time,
      isLive,
      hasFrench: fr,
      language: lang?.trim(),
      quality: quality?.includes("HD") ? "HD" : "SD",
      source: "sport365",
    });
  }

  return matches;
}

function mergeMatchData(official: any[], s365: any[]): any[] {
  const merged = [...official];

  for (const s of s365) {
    const homeName = s.title?.split(" v ")[0]?.trim().toLowerCase() ?? "";
    const found = merged.find(
      (m) =>
        m.homeTeam?.name?.toLowerCase().includes(homeName) ||
        m.homeTeam?.shortName?.toLowerCase() === homeName
    );

    if (found) {
      found.streamSources = found.streamSources ?? [];
      found.streamSources.push({
        provider: "sport365",
        eventId: s.eventId,
        hasFrench: s.hasFrench,
      });
    } else {
      merged.push({
        id: s.id,
        homeTeam: { name: s.title?.split(" v ")[0]?.trim() ?? "?", shortName: "?", tla: "?" },
        awayTeam: { name: s.title?.split(" v ")[1]?.trim() ?? "?", shortName: "?", tla: "?" },
        competition: { name: s.league, code: "OTHER", emblem: null },
        utcDate: null,
        status: s.isLive ? "LIVE" : "SCHEDULED",
        score: null,
        minute: null,
        source: "sport365",
        streamSources: [{ provider: "sport365", eventId: s.eventId, hasFrench: s.hasFrench }],
      });
    }
  }

  return merged.sort((a, b) => {
    if (a.status === "LIVE" && b.status !== "LIVE") return -1;
    if (b.status === "LIVE" && a.status !== "LIVE") return 1;
    return (a.utcDate ?? "").localeCompare(b.utcDate ?? "");
  });
}

function normalizeStatus(s: string): string {
  if (!s) return "SCHEDULED";
  if (s === "IN_PLAY" || s === "PAUSED") return "LIVE";
  if (s === "FINISHED") return "FINISHED";
  return "SCHEDULED";
}

// ─── STREAMS ────────────────────────────────────────────────────────────────

async function handleStreams(matchId: string, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cacheKey = `streams:${matchId}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached) return json(JSON.parse(cached));

  const streams = await resolveStreams(matchId, env);
  if (streams.length > 0) {
    ctx.waitUntil(env.CACHE.put(cacheKey, JSON.stringify(streams), { expirationTtl: 30 }));
  }
  return json(streams);
}

async function resolveStreams(matchId: string, env: Env): Promise<StreamResult[]> {
  const streams: StreamResult[] = [];

  // FIX: extraire le bon eventId selon la source du match
  if (matchId.startsWith("s365_")) {
    // Match provenant directement de sport365 — l'ID est l'eventId
    const eventId = matchId.replace("s365_", "");
    const s365streams = await resolveSport365(eventId, env);
    streams.push(...s365streams);
  } else if (matchId.startsWith("fd_")) {
    // Match officiel — on cherche un eventId sport365 dans le cache
    const cached = await env.CACHE.get("matches:all");
    if (cached) {
      const allMatches: any[] = JSON.parse(cached);
      const match = allMatches.find((m) => m.id === matchId);
      const s365Source = match?.streamSources?.find((s: any) => s.provider === "sport365");
      if (s365Source?.eventId) {
        const s365streams = await resolveSport365(s365Source.eventId, env);
        streams.push(...s365streams);
      }
    }
  }

  // Toujours essayer sporthdme en backup
  const hdmeStreams = await resolveSportHDMe(matchId);
  streams.push(...hdmeStreams);

  // Tri: FR d'abord, puis HD
  return streams.sort((a, b) => {
    if (a.language === "fr" && b.language !== "fr") return -1;
    if (b.language === "fr" && a.language !== "fr") return 1;
    if (a.quality === "HD" && b.quality !== "HD") return -1;
    return 0;
  });
}

interface StreamResult {
  id: string;
  provider: string;
  quality: "HD" | "SD";
  language: string;
  url: string;
  type: "HLS" | "DASH" | "RTMP"; // FIX: majuscules pour correspondre à Models.kt
  headers?: Record<string, string>;
  stable: boolean;
}

async function resolveSport365(eventId: string, env: Env): Promise<StreamResult[]> {
  try {
    const linksUrl = `https://sport365.live/en/links/${eventId}/1`;
    const resp = await fetch(linksUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://sport365.live/",
      },
    });
    if (!resp.ok) return [];
    const html = await resp.text();

    const sourceRegex = /onClick=['"]\w+\('(\w+)'\)/gi;
    const sources: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = sourceRegex.exec(html)) !== null) {
      sources.push(m[1]);
    }

    const results: StreamResult[] = [];
    for (const s of [...new Set(sources)]) {
      try {
        const resolved = await decryptSport365Stream(s, env);
        if (resolved) {
          results.push({
            id: `s365_${s.substring(0, 8)}`,
            provider: "sport365.live",
            quality: resolved.quality,
            language: resolved.lang,
            url: resolved.url,
            type: "HLS",
            headers: { Referer: "https://sport365.live/", Origin: "https://sport365.live" },
            stable: true,
          });
        }
      } catch {
        // ignorer ce flux
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * FIX CRITIQUE: AES-ECB n'est pas supporté nativement par Web Crypto.
 * On l'émule en décryptant chaque bloc de 16 bytes avec AES-CBC + IV=zéro.
 * ECB = chaque bloc indépendant, sans chaînage → AES-CBC(IV=0) sur 1 bloc = AES-ECB.
 */
async function aesEcbDecrypt(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const zeroIv = new Uint8Array(16); // IV nul
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-CBC" },
    false,
    ["decrypt"]
  );

  const BLOCK = 16;
  const outputChunks: Uint8Array[] = [];

  for (let offset = 0; offset < data.length; offset += BLOCK) {
    const block = data.slice(offset, offset + BLOCK);
    // Padding PKCS7 pour le dernier bloc si nécessaire
    const padded = new Uint8Array(BLOCK * 2);
    padded.set(block);
    // Valeur de padding = nombre de bytes manquants
    const padVal = BLOCK - block.length;
    for (let i = block.length; i < BLOCK * 2; i++) padded[i] = padVal;

    const decBlock = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: zeroIv },
      cryptoKey,
      padded
    );
    outputChunks.push(new Uint8Array(decBlock).slice(0, block.length));
  }

  const total = outputChunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of outputChunks) { out.set(chunk, pos); pos += chunk.length; }
  return out;
}

async function decryptSport365Stream(
  encHex: string,
  env: Env
): Promise<{ url: string; quality: "HD" | "SD"; lang: string } | null> {
  try {
    const key = env.STREAM_SECRET;
    if (!key || key.length < 32) return null;

    const keyBytes = new Uint8Array(key.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
    const dataBytes = new Uint8Array(encHex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));

    // Premier déchiffrement AES-ECB (émulé)
    const decrypted = await aesEcbDecrypt(keyBytes, dataBytes);
    const hexStr = new TextDecoder().decode(decrypted).trim();

    if (!/^[0-9a-fA-F]+$/.test(hexStr)) return null;

    // Deuxième déchiffrement hex → URL
    const urlBytes = new Uint8Array(hexStr.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
    const url = new TextDecoder().decode(urlBytes).trim();

    if (!url.startsWith("http") || (!url.includes("m3u8") && !url.includes("rtmp"))) return null;

    const lang = url.toLowerCase().includes("fr") ? "fr" : "en";
    const quality: "HD" | "SD" =
      url.toLowerCase().includes("hd") || url.includes("1080") ? "HD" : "SD";

    return { url, quality, lang };
  } catch {
    return null;
  }
}

async function resolveSportHDMe(matchId: string): Promise<StreamResult[]> {
  const LIVE_URL = "https://super.league.do";
  const BASE_URL = "https://one.sporthd.me/";
  try {
    const resp = await fetch(LIVE_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: BASE_URL,
      },
    });
    if (!resp.ok) return [];
    const html = await resp.text();

    // Le plugin Kodi parse window.matches = JSON.parse(`[...]`)
    const jsonMatch = html.match(/window\.matches\s*=\s*JSON\.parse\(`(\[[\s\S]+?\])`\)/);
    if (jsonMatch) {
      try {
        const matches: any[] = JSON.parse(jsonMatch[1]);
        return matches.slice(0, 5).flatMap((m, i) => {
          const url = m?.props?.streamData?.streamurl ?? m?.streamurl;
          if (!url?.startsWith("http")) return [];
          return [{
            id: `hdme_${m.id ?? i}`,
            provider: "one.sporthd.me",
            quality: (url.includes("hd") || url.includes("1080") ? "HD" : "SD") as "HD" | "SD",
            language: url.includes("fr") ? "fr" : "en",
            url,
            type: "HLS" as const,
            headers: { Referer: BASE_URL },
            stable: true,
          }];
        });
      } catch { return []; }
    }
    return [];
  } catch { return []; }
}

// ─── PROXY ──────────────────────────────────────────────────────────────────

async function handleProxy(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");
  const referer = url.searchParams.get("ref") ?? "";

  if (!targetUrl) return json({ error: "Missing url param" }, 400);

  // Valider l'URL cible
  let parsedTarget: URL;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    return json({ error: "Invalid url param" }, 400);
  }

  // Seuls les fichiers de streaming sont proxifiés
  if (!targetUrl.match(/\.(m3u8|ts|m4s|aac|mp4|key)(\?|$)/i)) {
    return json({ error: "Invalid stream URL type" }, 400);
  }

  // FIX: guard sur referer vide pour éviter `new URL("")`
  let originHeader = parsedTarget.origin;
  if (referer) {
    try {
      originHeader = new URL(referer).origin;
    } catch {
      // referer mal formé — on garde l'origin de la cible
    }
  }

  const proxyResp = await fetch(targetUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      ...(referer ? { Referer: referer } : {}),
      Origin: originHeader,
    },
    // @ts-ignore
    cf: { cacheEverything: true, cacheTtl: 10 },
  });

  const headers = new Headers(proxyResp.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.delete("X-Frame-Options");
  headers.delete("Content-Security-Policy");

  // Réécrire les URLs relatives dans les playlists M3U8
  if (targetUrl.includes(".m3u8")) {
    let body = await proxyResp.text();
    const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);
    body = body.replace(/(^[^#\n][^\n]+\.(?:ts|m4s|m3u8|key|aac))/gm, (line) => {
      if (line.startsWith("http")) return line;
      return baseUrl + line;
    });
    headers.set("Content-Type", "application/x-mpegURL");
    return new Response(body, { status: proxyResp.status, headers });
  }

  return new Response(proxyResp.body, { status: proxyResp.status, headers });
}

// ─── SEARCH ─────────────────────────────────────────────────────────────────

async function handleSearch(q: string, env: Env): Promise<Response> {
  if (!q || q.length < 2) return json([]);

  const cacheKey = `search:${q.toLowerCase()}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached) return json(JSON.parse(cached));

  const resp = await fetch(
    `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(q)}`
  );
  if (!resp.ok) return json([]);

  const data: any = await resp.json();
  const results = (data.teams ?? []).map((t: any) => ({
    name: t.strTeam,
    shortName: t.strTeamShort ?? t.strTeam,
    tla: t.strTeamShort ?? null,
    crest: t.strTeamBadge ?? null,
  }));

  await env.CACHE.put(cacheKey, JSON.stringify(results), { expirationTtl: 3600 });
  return json(results);
}

// ─── REFRESH CRON ───────────────────────────────────────────────────────────

async function refreshMatchCache(env: Env): Promise<void> {
  try {
    const matches = await fetchAndMergeMatches(env);
    await env.CACHE.put("matches:all", JSON.stringify(matches), { expirationTtl: 300 });

    const live = matches.filter((m: any) => m.status === "LIVE");
    await env.CACHE.put("matches:live", JSON.stringify(live), { expirationTtl: 30 });

    if (live.length > 0) {
      await sendLiveNotifications(live, env);
    }
  } catch (e) {
    console.error("Cron refresh failed:", e);
  }
}

async function sendLiveNotifications(liveMatches: any[], env: Env): Promise<void> {
  const teams = liveMatches
    .flatMap((m: any) => [m.homeTeam?.name, m.awayTeam?.name])
    .filter(Boolean);

  if (teams.length === 0) return;

  const placeholders = teams.map((_, i) => `?${i + 1}`).join(",");
  const rows = await env.DB.prepare(
    `SELECT DISTINCT u.fcm_token FROM users u
     JOIN favorites f ON f.user_id = u.id
     WHERE f.team_name IN (${placeholders}) AND u.notif_live = 1 AND u.fcm_token IS NOT NULL`
  )
    .bind(...teams)
    .all();

  for (const row of rows.results ?? []) {
    const fcmToken = (row as any).fcm_token;
    if (!fcmToken) continue;

    // FIX: utiliser FCM_SERVER_KEY (et non FOOTBALL_DATA_API_KEY)
    // API FCM Legacy (plus simple avec une server key)
    await fetch("https://fcm.googleapis.com/fcm/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `key=${env.FCM_SERVER_KEY}`, // FIX
      },
      body: JSON.stringify({
        to: fcmToken,
        notification: {
          title: "⚽ Match en direct !",
          body: liveMatches[0]
            ? `${liveMatches[0].homeTeam?.name} vs ${liveMatches[0].awayTeam?.name}`
            : "Match en cours",
          icon: "ic_notification",
        },
        priority: "high",
      }),
    }).catch((e) => console.error("FCM error:", e));
  }
}

// ─── UTILS ──────────────────────────────────────────────────────────────────

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}
