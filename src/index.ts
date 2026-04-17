/**
 * FutbolFR — Cloudflare Worker v4
 * ════════════════════════════════
 *
 * Sources actives :
 *  - streamed.pk    → matchs + streams (API publique JSON, gratuite, sans auth)
 *  - football-data.org → métadonnées officielles (plan GRATUIT : CL, PL, BL1, SA)
 *
 * Sources supprimées (mortes / bloquées depuis Workers) :
 *  - sport365.live  → Error 1010 (bot block Cloudflare)
 *  - sportsurge.net → Cloudflare challenge
 *  - viprow.me      → DNS/cert fail
 *
 * Endpoints exposés :
 *  GET /api/health
 *  GET /api/matches          → tous les matchs du jour (fusionnés)
 *  GET /api/matches/live     → matchs en direct uniquement
 *  GET /api/streams/:matchId → streams pour un match (matchId = streamed.pk id)
 *  GET /api/search?q=...     → recherche d'équipe (TheSportsDB)
 *  GET /api/proxy?url=&ref=  → proxy HLS (protégé par X-App-Token)
 */

export interface Env {
  CACHE: KVNamespace;
  DB: D1Database;
  FOOTBALL_DATA_API_KEY: string;
  FCM_SERVER_KEY: string;
  APP_TOKEN: string;
}

// ─── CONSTANTES ─────────────────────────────────────────────────────────────

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-App-Token",
};

const STREAMED_BASE = "https://streamed.pk";

// Plan gratuit football-data.org uniquement (PD et FL1 sont payants)
const FD_FREE_COMPETITIONS = ["CL", "PL", "BL1", "SA"];

// ─── ENTRYPOINT ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/health") {
        return json({ status: "ok", version: "4.0", ts: new Date().toISOString() });
      }

      if (path === "/api/matches" || path === "/api/matches/live") {
        return await handleMatches(env, ctx, path.includes("live"));
      }

      if (path.startsWith("/api/streams/")) {
        const matchId = path.split("/")[3];
        if (!matchId) return jsonError("Missing matchId", 400);
        return await handleStreams(matchId, env, ctx);
      }

      if (path === "/api/proxy") {
        const token = request.headers.get("X-App-Token") ?? url.searchParams.get("token");
        if (!env.APP_TOKEN || token !== env.APP_TOKEN) {
          return jsonError("Unauthorized", 401);
        }
        return await handleProxy(request, env);
      }

      if (path === "/api/search") {
        const q = url.searchParams.get("q") ?? "";
        return await handleSearch(q, env);
      }

      return jsonError("Not found", 404);
    } catch (e: any) {
      console.error("[Worker] Unhandled error:", e?.message ?? e);
      return jsonError(e?.message ?? "Internal error", 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(refreshMatchCache(env));
  },
};

// ─── MATCHES ────────────────────────────────────────────────────────────────

async function handleMatches(env: Env, ctx: ExecutionContext, liveOnly: boolean): Promise<Response> {
  const cacheKey = liveOnly ? "matches:live" : "matches:all";

  try {
    const cached = await env.CACHE.get(cacheKey);
    if (cached) return json(JSON.parse(cached));
  } catch { /* KV indisponible */ }

  const matches = await fetchAndMergeMatches(env);
  const filtered = liveOnly ? matches.filter((m: any) => m.status === "LIVE") : matches;

  const ttl = liveOnly ? 30 : 300;
  ctx.waitUntil(
    env.CACHE.put(cacheKey, JSON.stringify(filtered), { expirationTtl: ttl }).catch(() => {})
  );

  return json(filtered);
}

async function fetchAndMergeMatches(env: Env): Promise<any[]> {
  const [streamedResult, officialResult] = await Promise.allSettled([
    fetchStreamedMatches(),
    fetchOfficialMatches(env),
  ]);

  const streamed = streamedResult.status === "fulfilled" ? streamedResult.value : [];
  const official = officialResult.status === "fulfilled" ? officialResult.value : [];

  console.log(`[Matches] streamed.pk=${streamed.length} official=${official.length}`);

  return mergeMatches(streamed, official);
}

// ─── STREAMED.PK ────────────────────────────────────────────────────────────

/**
 * Récupère tous les matchs football du jour depuis streamed.pk.
 * On combine /api/matches/football (matchs du jour) et /api/matches/live.
 */
async function fetchStreamedMatches(): Promise<any[]> {
  const [todayRes, liveRes] = await Promise.allSettled([
    fetchJson(`${STREAMED_BASE}/api/matches/football`),
    fetchJson(`${STREAMED_BASE}/api/matches/live`),
  ]);

  const today: any[] = todayRes.status === "fulfilled" ? (todayRes.value ?? []) : [];
  const live: any[] = liveRes.status === "fulfilled"
    ? (liveRes.value ?? []).filter((m: any) => m.category === "football")
    : [];

  // Fusionner sans doublons (par id)
  const map = new Map<string, any>();
  for (const m of [...today, ...live]) {
    map.set(m.id, m);
  }

  const all = [...map.values()];
  console.log(`[Streamed] ${all.length} matchs football`);
  return all.map(normalizeStreamedMatch);
}

function normalizeStreamedMatch(m: any): any {
  const isLive = m.popular === true || Date.now() - m.date < 7200_000; // heuristique live
  return {
    id: `stm_${m.id}`,
    streamedId: m.id,         // id brut pour appel /api/stream/*
    homeTeam: {
      name: m.teams?.home?.name ?? m.title?.split(" vs ")?.[0]?.trim() ?? "?",
      shortName: m.teams?.home?.name ?? "?",
      crest: m.teams?.home?.badge
        ? `${STREAMED_BASE}/api/images/badge/${m.teams.home.badge}/50`
        : null,
      tla: null,
    },
    awayTeam: {
      name: m.teams?.away?.name ?? m.title?.split(" vs ")?.[1]?.trim() ?? "?",
      shortName: m.teams?.away?.name ?? "?",
      crest: m.teams?.away?.badge
        ? `${STREAMED_BASE}/api/images/badge/${m.teams.away.badge}/50`
        : null,
      tla: null,
    },
    competition: {
      name: "Football",
      code: "FOOT",
      emblem: null,
    },
    utcDate: m.date ? new Date(m.date).toISOString() : null,
    status: isLive ? "LIVE" : "SCHEDULED",
    score: null,
    minute: null,
    source: "streamed.pk",
    // Sources disponibles pour /api/streams/:id
    streamSources: (m.sources ?? []).map((s: any) => ({
      provider: `streamed.pk/${s.source}`,
      source: s.source,
      id: s.id,
    })),
    poster: m.poster ? `${STREAMED_BASE}/api/images/poster/${m.poster}/350` : null,
  };
}

// ─── FOOTBALL-DATA.ORG (Plan gratuit) ───────────────────────────────────────

async function fetchOfficialMatches(env: Env): Promise<any[]> {
  if (!env.FOOTBALL_DATA_API_KEY) {
    console.warn("[Official] FOOTBALL_DATA_API_KEY manquante");
    return [];
  }

  const today = new Date().toISOString().split("T")[0];
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().split("T")[0];
  const allMatches: any[] = [];

  for (const code of FD_FREE_COMPETITIONS) {
    try {
      const resp = await fetch(
        `https://api.football-data.org/v4/competitions/${code}/matches?dateFrom=${today}&dateTo=${tomorrow}`,
        { headers: { "X-Auth-Token": env.FOOTBALL_DATA_API_KEY } }
      );

      if (resp.status === 429) {
        console.warn(`[Official] 429 pour ${code}, on continue`);
        await sleep(2000);
        continue;
      }
      if (!resp.ok) {
        console.warn(`[Official] HTTP ${resp.status} pour ${code}`);
        continue;
      }

      const data: any = await resp.json();
      allMatches.push(...(data.matches ?? []));
    } catch (e) {
      console.warn(`[Official] Erreur pour ${code}:`, e);
    }

    await sleep(200);
  }

  console.log(`[Official] ${allMatches.length} matchs récupérés`);
  return allMatches.map(normalizeOfficialMatch);
}

function normalizeOfficialMatch(m: any): any {
  const scoreObj = m.score;
  const home = scoreObj?.fullTime?.home ?? scoreObj?.regularTime?.home ?? null;
  const away = scoreObj?.fullTime?.away ?? scoreObj?.regularTime?.away ?? null;

  return {
    id: `fd_${m.id}`,
    fdId: m.id,
    homeTeam: {
      name: m.homeTeam?.name ?? "?",
      shortName: m.homeTeam?.shortName ?? m.homeTeam?.name ?? "?",
      crest: m.homeTeam?.crest ?? null,
      tla: m.homeTeam?.tla ?? null,
    },
    awayTeam: {
      name: m.awayTeam?.name ?? "?",
      shortName: m.awayTeam?.shortName ?? m.awayTeam?.name ?? "?",
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
    score: home !== null ? { home, away } : null,
    minute: m.minute ?? null,
    source: "official",
    streamSources: [],
    poster: null,
  };
}

function normalizeStatus(s: string): string {
  if (!s) return "SCHEDULED";
  if (["IN_PLAY", "PAUSED", "HALFTIME"].includes(s)) return "LIVE";
  if (s === "FINISHED" || s === "AWARDED") return "FINISHED";
  if (["POSTPONED", "CANCELLED", "SUSPENDED"].includes(s)) return "CANCELLED";
  return "SCHEDULED";
}

// ─── MERGE ──────────────────────────────────────────────────────────────────

/**
 * Fusionne les données officielles (score, compétition) avec les données streamed.pk (streams).
 * Priorité : on enrichit les matchs officiels avec les streams streamed.pk quand on trouve
 * une correspondance sur le nom d'équipe. Les matchs streamed.pk sans correspondance
 * officielle sont ajoutés tels quels.
 */
function mergeMatches(streamed: any[], official: any[]): any[] {
  const merged = [...official];

  for (const s of streamed) {
    const homeName = s.homeTeam.name.toLowerCase();
    const awayName = s.awayTeam.name.toLowerCase();

    if (!homeName || homeName === "?") {
      merged.push(s);
      continue;
    }

    const found = merged.find((m) => {
      const mHome = (m.homeTeam?.name ?? "").toLowerCase();
      const mAway = (m.awayTeam?.name ?? "").toLowerCase();
      const mHomeSn = (m.homeTeam?.shortName ?? "").toLowerCase();

      return (
        mHome.includes(homeName.substring(0, 5)) ||
        homeName.includes(mHome.substring(0, 5)) ||
        mHomeSn === homeName ||
        (mAway.includes(awayName.substring(0, 5)) && awayName.length > 4)
      );
    });

    if (found) {
      // Enrichir le match officiel avec les streams streamed.pk
      found.streamSources = [...(found.streamSources ?? []), ...s.streamSources];
      found.poster = found.poster ?? s.poster;
      // Stocker l'id streamed pour les appels /api/streams
      found.streamedId = s.streamedId;
    } else {
      // Aucune correspondance officielle → ajouter le match streamed tel quel
      merged.push(s);
    }
  }

  // Tri : LIVE d'abord, puis chronologique
  return merged.sort((a, b) => {
    if (a.status === "LIVE" && b.status !== "LIVE") return -1;
    if (b.status === "LIVE" && a.status !== "LIVE") return 1;
    return (a.utcDate ?? "").localeCompare(b.utcDate ?? "");
  });
}

// ─── STREAMS ────────────────────────────────────────────────────────────────

interface StreamResult {
  id: string;
  provider: string;
  quality: "HD" | "SD";
  language: string;
  embedUrl: string;
  streamNo: number;
  source: string;
  requiresProxy: boolean;
}

async function handleStreams(matchId: string, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cacheKey = `streams:${matchId}`;

  try {
    const cached = await env.CACHE.get(cacheKey);
    if (cached) return json(JSON.parse(cached));
  } catch { /* KV indisponible */ }

  const streams = await resolveStreams(matchId, env);

  if (streams.length > 0) {
    ctx.waitUntil(
      env.CACHE.put(cacheKey, JSON.stringify(streams), { expirationTtl: 60 }).catch(() => {})
    );
  }

  return json(streams);
}

/**
 * Résout les streams pour un matchId.
 *
 * Le matchId peut être :
 *  - "stm_<streamedId>"  → match purement streamed.pk
 *  - "fd_<fdId>"         → match officiel (on cherche le streamedId dans le cache)
 */
async function resolveStreams(matchId: string, env: Env): Promise<StreamResult[]> {
  let streamSources: { source: string; id: string }[] = [];

  if (matchId.startsWith("stm_")) {
    // Match streamed.pk direct — on recharge les sources depuis l'API
    const rawId = matchId.replace("stm_", "");
    streamSources = await getStreamedSourcesForId(rawId);
  } else {
    // Match officiel — chercher le streamedId dans le cache des matchs
    try {
      const cached = await env.CACHE.get("matches:all");
      if (cached) {
        const allMatches: any[] = JSON.parse(cached);
        const match = allMatches.find((m) => m.id === matchId);
        if (match?.streamSources?.length) {
          streamSources = match.streamSources
            .filter((s: any) => s.source && s.id)
            .map((s: any) => ({ source: s.source, id: s.id }));
        } else if (match?.streamedId) {
          streamSources = await getStreamedSourcesForId(match.streamedId);
        }
      }
    } catch { /* ignore */ }
  }

  if (streamSources.length === 0) {
    console.warn(`[Streams] Aucune source pour matchId=${matchId}`);
    return [];
  }

  // Interroger chaque source streamed.pk en parallèle (max 5)
  const results = await Promise.allSettled(
    streamSources.slice(0, 5).map(({ source, id }) =>
      fetchStreamedStreams(source, id)
    )
  );

  const streams: StreamResult[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") streams.push(...r.value);
  }

  // Tri : FR d'abord, HD ensuite
  return streams.sort((a, b) => {
    const aFr = a.language.toLowerCase().includes("fr") ? 0 : 1;
    const bFr = b.language.toLowerCase().includes("fr") ? 0 : 1;
    if (aFr !== bFr) return aFr - bFr;
    if (a.quality === "HD" && b.quality !== "HD") return -1;
    if (b.quality === "HD" && a.quality !== "HD") return 1;
    return a.streamNo - b.streamNo;
  });
}

/**
 * Pour un match streamed.pk (id brut), récupère les sources disponibles
 * depuis l'API /api/matches/football et filtre par id.
 */
async function getStreamedSourcesForId(rawId: string): Promise<{ source: string; id: string }[]> {
  try {
    // On re-fetch le match depuis l'API pour avoir les sources à jour
    const data = await fetchJson(`${STREAMED_BASE}/api/matches/football`);
    if (!Array.isArray(data)) return [];

    const match = data.find((m: any) => m.id === rawId);
    if (!match?.sources) return [];

    return match.sources.map((s: any) => ({ source: s.source, id: s.id }));
  } catch (e) {
    console.warn(`[Streamed] Erreur getStreamedSourcesForId(${rawId}):`, e);
    return [];
  }
}

/**
 * Appelle /api/stream/{source}/{id} sur streamed.pk.
 * Retourne un tableau de StreamResult.
 */
async function fetchStreamedStreams(source: string, id: string): Promise<StreamResult[]> {
  try {
    const data = await fetchJson(`${STREAMED_BASE}/api/stream/${source}/${id}`);
    if (!Array.isArray(data)) return [];

    return data.map((s: any): StreamResult => ({
      id: s.id ?? `${source}_${s.streamNo}`,
      provider: `streamed.pk (${source})`,
      quality: s.hd ? "HD" : "SD",
      language: s.language ?? "en",
      embedUrl: s.embedUrl ?? "",
      streamNo: s.streamNo ?? 0,
      source: s.source ?? source,
      requiresProxy: false, // embedUrl est un iframe, pas besoin de notre proxy HLS
    }));
  } catch (e) {
    console.warn(`[Streamed] Erreur fetchStreamedStreams(${source}/${id}):`, e);
    return [];
  }
}

// ─── PROXY HLS ──────────────────────────────────────────────────────────────

async function handleProxy(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");
  const referer = url.searchParams.get("ref") ?? "";

  if (!targetUrl) return jsonError("Missing url param", 400);

  let parsedTarget: URL;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    return jsonError("Invalid url param", 400);
  }

  const isStreamingResource =
    /\.(m3u8|ts|m4s|aac|mp4|key|fmp4|cmaf)(\?|$)/i.test(targetUrl) ||
    /\/(seg|chunk|fragment|track|media|index|playlist|stream|live)\d*/i.test(parsedTarget.pathname) ||
    parsedTarget.pathname.includes("/hls/") ||
    parsedTarget.pathname.includes("/dash/") ||
    parsedTarget.pathname.includes("/live/") ||
    url.searchParams.get("force") === "1";

  if (!isStreamingResource) {
    return jsonError("Invalid stream URL type", 400);
  }

  let originHeader = parsedTarget.origin;
  let refererHeader = "";
  if (referer) {
    try {
      const refUrl = new URL(referer);
      originHeader = refUrl.origin;
      refererHeader = referer;
    } catch { /* referer mal formé */ }
  }

  const proxyResp = await fetch(targetUrl, {
    headers: {
      "User-Agent": UA,
      ...(refererHeader ? { "Referer": refererHeader } : {}),
      "Origin": originHeader,
      "Accept": "*/*",
    },
    redirect: "follow",
    // @ts-ignore CF-specific
    cf: { cacheEverything: targetUrl.includes(".ts") || targetUrl.includes(".m4s"), cacheTtl: 5 },
  });

  const responseHeaders = new Headers(proxyResp.headers);
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("Access-Control-Allow-Headers", "*");
  responseHeaders.delete("X-Frame-Options");
  responseHeaders.delete("Content-Security-Policy");

  const contentType = proxyResp.headers.get("Content-Type") ?? "";
  const isM3u8 = targetUrl.includes(".m3u8") || contentType.includes("mpegURL") || contentType.includes("m3u8");

  if (isM3u8) {
    let body = await proxyResp.text();
    const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);
    const selfBase = `${new URL(request.url).origin}/api/proxy?token=${env.APP_TOKEN}&ref=${encodeURIComponent(targetUrl)}&url=`;
    body = rewriteM3U8(body, baseUrl, selfBase);
    responseHeaders.set("Content-Type", "application/vnd.apple.mpegurl");
    responseHeaders.set("Cache-Control", "no-cache");
    return new Response(body, { status: proxyResp.status, headers: responseHeaders });
  }

  responseHeaders.delete("Content-Encoding");
  return new Response(proxyResp.body, { status: proxyResp.status, headers: responseHeaders });
}

function rewriteM3U8(body: string, baseUrl: string, proxyPrefix: string): string {
  return body
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#EXTINF") || trimmed.startsWith("#EXT-X-STREAM-INF")) return line;

      if (trimmed.startsWith("#EXT-X-KEY")) {
        return trimmed.replace(/URI="([^"]+)"/, (_m, uri) => {
          const abs = absolutize(uri, baseUrl);
          return `URI="${proxyPrefix}${encodeURIComponent(abs)}&force=1"`;
        });
      }

      if (trimmed.startsWith("#EXT-X-MAP")) {
        return trimmed.replace(/URI="([^"]+)"/, (_m, uri) => {
          const abs = absolutize(uri, baseUrl);
          return `URI="${proxyPrefix}${encodeURIComponent(abs)}&force=1"`;
        });
      }

      if (!trimmed.startsWith("#")) {
        const abs = absolutize(trimmed, baseUrl);
        return `${proxyPrefix}${encodeURIComponent(abs)}&force=1`;
      }

      return line;
    })
    .join("\n");
}

function absolutize(url: string, base: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) {
    try { return `${new URL(base).origin}${url}`; } catch { return url; }
  }
  try { return new URL(url, base).href; } catch { return base + url; }
}

// ─── SEARCH ─────────────────────────────────────────────────────────────────

async function handleSearch(q: string, env: Env): Promise<Response> {
  if (!q || q.length < 2) return json([]);

  const cacheKey = `search:${q.toLowerCase().trim()}`;
  try {
    const cached = await env.CACHE.get(cacheKey);
    if (cached) return json(JSON.parse(cached));
  } catch { /* ignore */ }

  try {
    const data: any = await fetchJson(
      `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(q)}`
    );
    const results = (data?.teams ?? []).map((t: any) => ({
      name: t.strTeam,
      shortName: t.strTeamShort ?? t.strTeam,
      tla: t.strTeamShort ?? null,
      crest: t.strTeamBadge ?? null,
      league: t.strLeague ?? null,
      country: t.strCountry ?? null,
    }));

    env.CACHE.put(cacheKey, JSON.stringify(results), { expirationTtl: 3600 }).catch(() => {});
    return json(results);
  } catch (e) {
    console.warn("[Search] Erreur:", e);
    return json([]);
  }
}

// ─── CRON ───────────────────────────────────────────────────────────────────

async function refreshMatchCache(env: Env): Promise<void> {
  try {
    console.log("[Cron] Rafraîchissement cache...");
    const matches = await fetchAndMergeMatches(env);

    await env.CACHE.put("matches:all", JSON.stringify(matches), { expirationTtl: 300 });

    const live = matches.filter((m: any) => m.status === "LIVE");
    await env.CACHE.put("matches:live", JSON.stringify(live), { expirationTtl: 30 });

    console.log(`[Cron] ${matches.length} matchs, ${live.length} live`);

    if (live.length > 0 && env.FCM_SERVER_KEY && env.DB) {
      await sendLiveNotifications(live, env);
    }
  } catch (e) {
    console.error("[Cron] Erreur:", e);
  }
}

async function sendLiveNotifications(liveMatches: any[], env: Env): Promise<void> {
  const teams = liveMatches
    .flatMap((m: any) => [m.homeTeam?.name, m.awayTeam?.name])
    .filter(Boolean);

  if (teams.length === 0) return;

  try {
    const placeholders = teams.map((_, i) => `?${i + 1}`).join(",");
    const rows = await env.DB.prepare(
      `SELECT DISTINCT u.fcm_token FROM users u
       JOIN favorites f ON f.user_id = u.id
       WHERE f.team_name IN (${placeholders})
         AND u.notif_live = 1
         AND u.fcm_token IS NOT NULL
       LIMIT 50`
    ).bind(...teams).all();

    const tokens = (rows.results ?? []).map((r: any) => r.fcm_token).filter(Boolean) as string[];
    if (tokens.length === 0) return;

    const notifBody = liveMatches
      .slice(0, 3)
      .map((m: any) => `${m.homeTeam?.name} vs ${m.awayTeam?.name}`)
      .join(", ");

    await Promise.allSettled(
      tokens.map((token) =>
        fetch("https://fcm.googleapis.com/fcm/send", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `key=${env.FCM_SERVER_KEY}`,
          },
          body: JSON.stringify({
            to: token,
            notification: {
              title: "⚽ Matchs en direct !",
              body: notifBody,
              icon: "ic_notification",
              sound: "default",
            },
            data: { type: "LIVE_MATCHES", count: String(liveMatches.length) },
            priority: "high",
          }),
        })
      )
    );

    console.log(`[FCM] ${tokens.length} notifications envoyées`);
  } catch (e) {
    console.error("[FCM] Erreur:", e);
  }
}

// ─── UTILS ──────────────────────────────────────────────────────────────────

async function fetchJson(url: string): Promise<any> {
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "application/json" },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.json();
}

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data, null, 0), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function jsonError(message: string, status: number): Response {
  return json({ error: message }, status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
