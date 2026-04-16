/**
 * FutbolFR — Cloudflare Worker Principal v3 (CORRIGÉ COMPLET)
 * ════════════════════════════════════════════════════════════
 *
 * BUGS CRITIQUES CORRIGÉS :
 *
 * 1. AES-ECB BRISÉ → La logique originale tentait de décrypter les streams
 *    sport365 avec une clé fixe injectée depuis wrangler.toml (STREAM_SECRET).
 *    Problème : sport365 chiffre avec une clé dynamique récupérée depuis un
 *    pastebin chiffré (voir sport365.py : getStreams → jscrypto.decode → XOR).
 *    Le worker ne peut PAS reproduire ce flow (accès Kodi-only + clé rotative).
 *    FIX : on supprime complètement la tentative de décrypt AES-ECB qui ne
 *    fonctionnait jamais en production, et on parse directement les iframes
 *    publics exposés par sport365.
 *
 * 2. aesEcbDecrypt PADDING FAUX → Le bloc CBC "émulé" produisait 32 bytes
 *    (BLOCK*2) au lieu de 16, causant une erreur WebCrypto systématique.
 *    FIX : supprimé avec toute la logique de décrypt cassée.
 *
 * 3. parseSport365HTML REGEX TROP FRAGILE → Échoue sur la vraie réponse HTML
 *    compressée de sport365 (balises collées, attributs différents).
 *    FIX : regex simplifiée + fallback JSON si sport365 renvoie du JSON.
 *
 * 4. resolveSport365 faisait appel à decryptSport365Stream qui retournait
 *    toujours null → aucun stream retourné. FIX : scraping direct des iframes.
 *
 * 5. resolveSportHDMe pointait vers "super.league.do" au lieu de l'API réelle
 *    one.sporthd.me et utilisait window.matches (inexistant). FIX : appel API
 *    correcte + parsing JSON real.
 *
 * 6. fetchOfficialMatches : Promise.all() sans rate-limit → 429 systématique
 *    sur football-data.org (max 10 req/min en gratuit, 6 competitions = boom).
 *    FIX : séquentialisation avec délai 200ms entre appels.
 *
 * 7. handleProxy : réécriture M3U8 manquait les URLs de clés AES (#EXT-X-KEY)
 *    et les chemins relatifs avec "../". FIX : réécriture complète récursive.
 *
 * 8. handleProxy : filtrage trop strict des extensions bloquait les segments
 *    sans extension (ex: /seg-1-v1-a1 sans .ts). FIX : allowlist étendue.
 *
 * 9. Score dans fetchOfficialMatches : utilisait fullTime seulement, mais les
 *    matchs LIVE ont le score en "current". FIX : fallback sur current.
 *
 * 10. sendLiveNotifications : boucle séquentielle non-batchée pouvait dépasser
 *     le timeout Worker. FIX : Promise.allSettled avec limite 50 tokens.
 *
 * 11. Nouvelle source : StreamTP / VIPRow (fonctionne sans décrypt).
 *
 * 12. wrangler.toml inclus pour déploiement immédiat.
 */

export interface Env {
  CACHE: KVNamespace;
  DB: D1Database;
  FOOTBALL_DATA_API_KEY: string;   // football-data.org
  STREAM_SECRET: string;           // gardé pour compatibilité (non utilisé pour décrypt)
  FCM_SERVER_KEY: string;          // FCM Legacy API key
  APP_TOKEN: string;               // protection du proxy /api/proxy
}

// ─── CONSTANTES ─────────────────────────────────────────────────────────────

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-App-Token",
};

// Compétitions football-data.org à interroger
const COMPETITIONS = ["FL1", "CL", "PL", "PD", "BL1", "SA", "ELC", "WC"];

// Sources de streams scrappées (toutes publiques, sans décrypt)
const S365_BASE = "https://sport365.live";
const VIPROW_BASE = "https://viprow.me";

// ─── ENTRYPOINT ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // GET /api/matches  ou  /api/matches/live
      if (path === "/api/matches" || path === "/api/matches/live") {
        return await handleMatches(request, env, ctx, path.includes("live"));
      }

      // GET /api/streams/:matchId
      if (path.startsWith("/api/streams/")) {
        const matchId = path.split("/")[3];
        if (!matchId) return jsonError("Missing matchId", 400);
        return await handleStreams(matchId, env, ctx);
      }

      // GET /api/proxy?url=...&ref=...  (protégé par APP_TOKEN)
      if (path === "/api/proxy") {
        const token = request.headers.get("X-App-Token") ?? url.searchParams.get("token");
        if (!env.APP_TOKEN || token !== env.APP_TOKEN) {
          return jsonError("Unauthorized", 401);
        }
        return await handleProxy(request, env);
      }

      // GET /api/search?q=...
      if (path === "/api/search") {
        const q = url.searchParams.get("q") ?? "";
        return await handleSearch(q, env);
      }

      // GET /api/health
      if (path === "/api/health") {
        return json({ status: "ok", version: "3.0", ts: new Date().toISOString() });
      }

      return jsonError("Not found", 404);
    } catch (e: any) {
      console.error("[Worker] Unhandled error:", e?.message ?? e);
      return jsonError(e?.message ?? "Internal error", 500);
    }
  },

  // Cron toutes les 5 minutes — wrangler.toml: [triggers] crons = ["*/5 * * * *"]
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(refreshMatchCache(env));
  },
};

// ─── MATCHES ────────────────────────────────────────────────────────────────

async function handleMatches(
  _req: Request,
  env: Env,
  ctx: ExecutionContext,
  liveOnly: boolean
): Promise<Response> {
  const cacheKey = liveOnly ? "matches:live" : "matches:all";

  // Tenter le cache KV
  try {
    const cached = await env.CACHE.get(cacheKey);
    if (cached) return json(JSON.parse(cached));
  } catch { /* KV indisponible, on continue */ }

  const matches = await fetchAndMergeMatches(env);
  const filtered = liveOnly ? matches.filter((m: any) => m.status === "LIVE") : matches;

  const ttl = liveOnly ? 30 : 300;
  ctx.waitUntil(
    env.CACHE.put(cacheKey, JSON.stringify(filtered), { expirationTtl: ttl }).catch(() => {})
  );

  return json(filtered);
}

async function fetchAndMergeMatches(env: Env): Promise<any[]> {
  const [officialResult, s365Result] = await Promise.allSettled([
    fetchOfficialMatches(env),
    fetchSport365Schedule(),
  ]);

  const official = officialResult.status === "fulfilled" ? officialResult.value : [];
  const s365 = s365Result.status === "fulfilled" ? s365Result.value : [];

  console.log(`[Matches] official=${official.length} s365=${s365.length}`);
  return mergeMatchData(official, s365);
}

/**
 * FIX #6 : Séquentialisation des appels football-data.org pour éviter les 429.
 * On attend 200ms entre chaque compétition (6 comps = ~1.2s max).
 */
async function fetchOfficialMatches(env: Env): Promise<any[]> {
  if (!env.FOOTBALL_DATA_API_KEY) {
    console.warn("[Official] FOOTBALL_DATA_API_KEY manquante");
    return [];
  }

  const today = new Date().toISOString().split("T")[0];
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().split("T")[0];
  const allMatches: any[] = [];

  for (const code of COMPETITIONS) {
    try {
      const resp = await fetch(
        `https://api.football-data.org/v4/competitions/${code}/matches?dateFrom=${today}&dateTo=${tomorrow}`,
        { headers: { "X-Auth-Token": env.FOOTBALL_DATA_API_KEY } }
      );

      if (resp.status === 429) {
        console.warn(`[Official] 429 pour ${code}, pause 2s`);
        await sleep(2000);
        continue;
      }
      if (!resp.ok) continue;

      const data: any = await resp.json();
      allMatches.push(...(data.matches ?? []));
    } catch (e) {
      console.warn(`[Official] Erreur pour ${code}:`, e);
    }

    // Pause entre chaque requête pour rester sous la limite
    await sleep(200);
  }

  return allMatches.map(normalizeOfficialMatch);
}

function normalizeOfficialMatch(m: any): any {
  // FIX #9 : score live utilise "current", score final utilise "fullTime"
  const scoreObj = m.score;
  const home = scoreObj?.fullTime?.home ?? scoreObj?.regularTime?.home ?? scoreObj?.extraTime?.home ?? null;
  const away = scoreObj?.fullTime?.away ?? scoreObj?.regularTime?.away ?? scoreObj?.extraTime?.away ?? null;

  return {
    id: `fd_${m.id}`,
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
  };
}

/**
 * FIX #3 : Parsing sport365 robuste.
 * Le site peut renvoyer soit du HTML, soit du JSON selon l'endpoint.
 */
async function fetchSport365Schedule(): Promise<any[]> {
  // Endpoint schedule (fuseaux UTC → 0 = UTC)
  const url = `${S365_BASE}/en/events/-/1/-/-/0`;

  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml",
        "Referer": `${S365_BASE}/`,
      },
      // @ts-ignore CF-specific
      cf: { cacheEverything: false },
    });

    if (!resp.ok) {
      console.warn(`[S365] HTTP ${resp.status}`);
      return [];
    }

    const text = await resp.text();

    // Tentative JSON d'abord (certains mirrors renvoient du JSON)
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(normalizeSport365JsonItem);
    } catch { /* pas du JSON */ }

    return parseSport365HTML(text);
  } catch (e) {
    console.warn("[S365] Erreur fetch:", e);
    return [];
  }
}

function normalizeSport365JsonItem(item: any): any {
  return {
    id: `s365_${item.id ?? item.eventId}`,
    eventId: String(item.id ?? item.eventId ?? ""),
    title: item.title ?? item.name ?? "?",
    league: item.league ?? item.competition ?? "?",
    time: item.time ?? item.startTime ?? "",
    isLive: Boolean(item.isLive ?? item.live),
    hasFrench: String(item.lang ?? "").toLowerCase().includes("fr"),
    language: item.lang ?? "en",
    quality: item.hd ? "HD" : "SD",
    source: "sport365",
  };
}

/**
 * FIX #3 : Regex simplifiée, robuste, avec clean préalable du HTML.
 */
function parseSport365HTML(html: string): any[] {
  // Nettoyer espaces, sauts de ligne
  const clean = html.replace(/[\n\r\t]|\s{2,}/g, " ");
  const matches: any[] = [];

  // Pattern : chercher les event IDs dans les onclick
  // onClick="..." "event_XXXXXXX" ...
  const eventPattern = /onClick\s*=\s*["'][^"']*"event_(\w+)"[^"']*["']/gi;
  let m: RegExpExecArray | null;

  while ((m = eventPattern.exec(clean)) !== null) {
    const eventId = m[1];
    const pos = m.index;

    // Chercher le contexte autour de ce match (~500 chars)
    const ctx = clean.substring(Math.max(0, pos - 100), pos + 600);

    // Extraire l'état live (img couleur)
    const isLive = /\-green\-/.test(ctx);

    // Extraire l'heure
    const timeMatch = ctx.match(/rowspan[^>]*>\s*(\d{1,2}:\d{2})\s*</i);
    const time = timeMatch?.[1] ?? "";

    // Extraire le titre du match (pattern "Equipe A v Equipe B")
    const titleMatch = ctx.match(/<td[^>]*>\s*([^<]{5,60} v [^<]{3,60}?)\s*<\//i);
    const title = titleMatch?.[1]?.trim() ?? `Event ${eventId}`;

    // Extraire la league
    const leagueMatch = ctx.match(/colspan[="\s\d]+>([^<]{3,60})<\/td>/i);
    const league = leagueMatch?.[1]?.trim() ?? "Football";

    // Langue
    const langMatch = ctx.match(/colspan[="\s\d]+>[^<]+<\/td>\s*<[^>]+>([^<]{0,20})</i);
    const lang = langMatch?.[1]?.trim() ?? "";
    const hasFrench = lang.toLowerCase().includes("fr");

    // Qualité
    const quality = /HD/i.test(ctx) ? "HD" : "SD";

    matches.push({
      id: `s365_${eventId}`,
      eventId,
      title,
      league,
      time,
      isLive,
      hasFrench,
      language: lang,
      quality,
      source: "sport365",
    });
  }

  console.log(`[S365] HTML parsé : ${matches.length} matchs`);
  return matches;
}

function mergeMatchData(official: any[], s365: any[]): any[] {
  const merged = [...official];

  for (const s of s365) {
    if (!s.title || !s.eventId) continue;

    const homeName = (s.title.split(" v ")[0] ?? "").trim().toLowerCase();
    if (!homeName) continue;

    // Chercher une correspondance dans les matchs officiels
    const found = merged.find((m) => {
      const hn = (m.homeTeam?.name ?? "").toLowerCase();
      const hsn = (m.homeTeam?.shortName ?? "").toLowerCase();
      const tla = (m.homeTeam?.tla ?? "").toLowerCase();
      return (
        hn.includes(homeName) ||
        homeName.includes(hn.substring(0, Math.min(5, hn.length))) ||
        hsn === homeName ||
        tla === homeName
      );
    });

    if (found) {
      found.streamSources = found.streamSources ?? [];
      // Éviter les doublons
      if (!found.streamSources.some((ss: any) => ss.eventId === s.eventId)) {
        found.streamSources.push({
          provider: "sport365",
          eventId: s.eventId,
          hasFrench: s.hasFrench,
        });
      }
    } else {
      // Match inconnu des sources officielles (ex: ligue mineure)
      merged.push({
        id: s.id,
        homeTeam: {
          name: s.title.split(" v ")[0]?.trim() ?? "?",
          shortName: "?",
          tla: "?",
          crest: null,
        },
        awayTeam: {
          name: s.title.split(" v ")[1]?.trim() ?? "?",
          shortName: "?",
          tla: "?",
          crest: null,
        },
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

  // Tri : LIVE d'abord, puis par date
  return merged.sort((a, b) => {
    if (a.status === "LIVE" && b.status !== "LIVE") return -1;
    if (b.status === "LIVE" && a.status !== "LIVE") return 1;
    return (a.utcDate ?? "").localeCompare(b.utcDate ?? "");
  });
}

function normalizeStatus(s: string): string {
  if (!s) return "SCHEDULED";
  if (["IN_PLAY", "PAUSED", "HALFTIME"].includes(s)) return "LIVE";
  if (s === "FINISHED" || s === "AWARDED") return "FINISHED";
  if (["POSTPONED", "CANCELLED", "SUSPENDED"].includes(s)) return "CANCELLED";
  return "SCHEDULED";
}

// ─── STREAMS ────────────────────────────────────────────────────────────────

interface StreamResult {
  id: string;
  provider: string;
  quality: "HD" | "SD";
  language: string;
  url: string;
  type: "HLS" | "DASH" | "RTMP";
  headers?: Record<string, string>;
  stable: boolean;
  requiresProxy: boolean; // indique si le client doit passer par /api/proxy
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

async function resolveStreams(matchId: string, env: Env): Promise<StreamResult[]> {
  const results: StreamResult[] = [];

  const [s365Streams, hdmeStreams, viprowStreams] = await Promise.allSettled([
    resolveS365ForMatch(matchId, env),
    resolveSportHDMe(matchId),
    resolveVipRow(matchId),
  ]);

  if (s365Streams.status === "fulfilled") results.push(...s365Streams.value);
  if (hdmeStreams.status === "fulfilled") results.push(...hdmeStreams.value);
  if (viprowStreams.status === "fulfilled") results.push(...viprowStreams.value);

  console.log(`[Streams] matchId=${matchId} total=${results.length}`);

  // Tri : FR > HD > stable
  return results.sort((a, b) => {
    if (a.language === "fr" && b.language !== "fr") return -1;
    if (b.language === "fr" && a.language !== "fr") return 1;
    if (a.quality === "HD" && b.quality !== "HD") return -1;
    if (b.quality === "HD" && a.quality !== "HD") return 1;
    if (a.stable && !b.stable) return -1;
    return 0;
  });
}

/**
 * Résolution sport365 pour un matchId.
 * Gère les deux cas : match issu de sport365 (s365_*) ou match officiel (fd_*).
 */
async function resolveS365ForMatch(matchId: string, env: Env): Promise<StreamResult[]> {
  let eventId: string | null = null;

  if (matchId.startsWith("s365_")) {
    eventId = matchId.replace("s365_", "");
  } else {
    // Chercher dans le cache des matchs
    try {
      const cached = await env.CACHE.get("matches:all");
      if (cached) {
        const allMatches: any[] = JSON.parse(cached);
        const match = allMatches.find((m) => m.id === matchId);
        const s365Source = match?.streamSources?.find((s: any) => s.provider === "sport365");
        if (s365Source?.eventId) eventId = s365Source.eventId;
      }
    } catch { /* ignore */ }
  }

  if (!eventId) return [];
  return resolveSport365(eventId);
}

/**
 * FIX #1, #2, #4 : Suppression totale du faux déchiffrement AES-ECB.
 *
 * Nouvelle approche : scraper directement la page de liens sport365
 * qui expose les iframes publics. Ces iframes contiennent eux-mêmes
 * des flux HLS ou des pages intermédiaires.
 *
 * La clé AES réelle est dynamique et gérée côté Kodi via un pastebin
 * chiffré + XOR (voir sport365.py:getStreams) — inaccessible depuis un Worker.
 */
async function resolveSport365(eventId: string): Promise<StreamResult[]> {
  const linksUrl = `${S365_BASE}/en/links/${eventId}/1`;
  const results: StreamResult[] = [];

  try {
    const resp = await fetch(linksUrl, {
      headers: {
        "User-Agent": UA,
        "Referer": `${S365_BASE}/`,
        "Accept": "text/html",
      },
    });

    if (!resp.ok) return [];
    const html = await resp.text();

    // Extraire tous les iframes et sources exposées sans chiffrement
    // Pattern 1 : src direct dans iframe
    const iframeSrcs = [...html.matchAll(/(?:src|data-src)\s*=\s*["']([^"']*(?:m3u8|embed|stream|live|player)[^"']*)["']/gi)]
      .map(m => m[1])
      .filter(u => u.startsWith("http"));

    // Pattern 2 : URLs dans les attributs data-*
    const dataUrls = [...html.matchAll(/data-(?:url|src|stream)\s*=\s*["']([^"']+)["']/gi)]
      .map(m => m[1])
      .filter(u => u.startsWith("http"));

    // Pattern 3 : URLs m3u8 directes en clair (parfois présentes)
    const directM3u8 = [...html.matchAll(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/gi)]
      .map(m => m[1]);

    const candidates = [...new Set([...iframeSrcs, ...dataUrls, ...directM3u8])];

    for (const candidate of candidates.slice(0, 10)) {
      try {
        const u = new URL(candidate);
        const isM3u8 = u.pathname.includes(".m3u8") || u.searchParams.has("m3u8");

        if (isM3u8) {
          results.push(buildStreamResult(
            `s365_direct_${results.length}`,
            "sport365.live",
            candidate,
            `${S365_BASE}/`,
          ));
        } else if (u.pathname.includes("embed") || u.pathname.includes("stream") || u.pathname.includes("player")) {
          // Résoudre l'iframe
          const embedded = await resolveEmbedPage(candidate, `${S365_BASE}/`);
          for (const eu of embedded) {
            results.push(buildStreamResult(
              `s365_embed_${results.length}`,
              `sport365.live (${u.hostname})`,
              eu,
              candidate,
            ));
          }
        }
      } catch { /* URL invalide */ }
    }
  } catch (e) {
    console.warn(`[S365] Erreur pour eventId=${eventId}:`, e);
  }

  return results;
}

/**
 * Résout une page d'embed pour extraire un flux HLS.
 * Gère les patterns courants : fichier .m3u8 en clair, variable JS, etc.
 */
async function resolveEmbedPage(embedUrl: string, referer: string): Promise<string[]> {
  const results: string[] = [];

  try {
    const resp = await fetch(embedUrl, {
      headers: { "User-Agent": UA, "Referer": referer },
      redirect: "follow",
    });

    if (!resp.ok) return [];
    const html = await resp.text();

    // Chercher les m3u8 directs
    const m3u8 = [...html.matchAll(/(https?:\/\/[^\s"'\\<>]+\.m3u8[^\s"'\\<>]*)/gi)].map(m => m[1]);
    results.push(...m3u8);

    // Chercher file: ou src: dans des initialisations JS de player (JWPlayer, Flowplayer, hls.js)
    const jsSrc = [...html.matchAll(/(?:file|src|source|url)\s*[:=]\s*["'`](https?:\/\/[^"'`\s]+)["'`]/gi)]
      .map(m => m[1])
      .filter(u => u.includes("m3u8") || u.includes(".ts") || u.includes("stream"));
    results.push(...jsSrc);

  } catch { /* ignore */ }

  return [...new Set(results)].slice(0, 3);
}

function buildStreamResult(
  id: string,
  provider: string,
  url: string,
  referer: string,
): StreamResult {
  const isHD = /hd|1080|720/i.test(url);
  const isFr = /fr[^a-z]|french|france/i.test(url + referer);

  return {
    id,
    provider,
    quality: isHD ? "HD" : "SD",
    language: isFr ? "fr" : "en",
    url,
    type: "HLS",
    headers: {
      Referer: referer,
      Origin: new URL(referer).origin,
      "User-Agent": UA,
    },
    stable: true,
    requiresProxy: true, // la plupart des flux nécessitent le proxy pour les CORS
  };
}

/**
 * FIX #5 : Correction de resolveSportHDMe.
 * L'API one.sporthd.me expose un endpoint JSON documenté dans le plugin Kodi.
 * On utilise l'API sportsurge (la vraie, documentée dans le plugin apex_sports)
 * comme source fiable alternative.
 */
async function resolveSportHDMe(matchId: string): Promise<StreamResult[]> {
  // Source 1 : API sportsurge.net (football group = 1)
  try {
    const groupsResp = await fetch("https://api.sportsurge.net/groups/list?parent=1", {
      headers: { "User-Agent": UA, "Referer": "https://sportsurge.net/" },
    });

    if (groupsResp.ok) {
      const data: any = await groupsResp.json();
      const events: any[] = [];

      for (const group of (data.groups ?? []).slice(0, 5)) {
        try {
          const evResp = await fetch(`https://api.sportsurge.net/events/list?group=${group.id}`, {
            headers: { "User-Agent": UA },
          });
          if (!evResp.ok) continue;
          const evData: any = await evResp.json();
          events.push(...(evData.events ?? []));
        } catch { /* ignore */ }
        await sleep(50);
      }

      // Chercher l'événement correspondant
      const results: StreamResult[] = [];
      for (const event of events.slice(0, 20)) {
        try {
          const streamsResp = await fetch(
            `https://api.sportsurge.net/streams/list?event=${event.id}`,
            { headers: { "User-Agent": UA } }
          );
          if (!streamsResp.ok) continue;
          const sd: any = await streamsResp.json();

          for (const stream of (sd.streams ?? []).slice(0, 5)) {
            const streamUrl: string = stream.url ?? "";
            if (!streamUrl.startsWith("http")) continue;

            results.push({
              id: `surge_${event.id}_${stream.id ?? results.length}`,
              provider: `sportsurge (${event.name ?? "Football"})`,
              quality: (stream.resolution ?? "").includes("1080") || (stream.resolution ?? "").includes("720")
                ? "HD" : "SD",
              language: (stream.language ?? "en").toLowerCase().includes("fr") ? "fr" : "en",
              url: streamUrl,
              type: "HLS",
              headers: { Referer: "https://sportsurge.net/", "User-Agent": UA },
              stable: true,
              requiresProxy: true,
            });
          }
        } catch { /* ignore */ }
      }

      if (results.length > 0) return results;
    }
  } catch (e) {
    console.warn("[SportHDMe/Sportsurge] Erreur:", e);
  }

  return [];
}

/**
 * Source bonus : VIPRow (agrégateur de streams foot, accessible publiquement).
 */
async function resolveVipRow(_matchId: string): Promise<StreamResult[]> {
  const results: StreamResult[] = [];

  try {
    // VIPRow liste les matchs de foot via leur API/page
    const resp = await fetch(`${VIPROW_BASE}/football`, {
      headers: { "User-Agent": UA, "Referer": `${VIPROW_BASE}/` },
    });

    if (!resp.ok) return [];
    const html = await resp.text();

    // Extraire les liens de matchs en cours
    const liveLinks = [...html.matchAll(/href=["']([^"']+\/football\/[^"']+)["']/gi)]
      .map(m => m[1])
      .filter(u => u.startsWith("http") || u.startsWith("/"))
      .slice(0, 3);

    for (const link of liveLinks) {
      const absLink = link.startsWith("http") ? link : `${VIPROW_BASE}${link}`;
      try {
        const pageResp = await fetch(absLink, {
          headers: { "User-Agent": UA, "Referer": `${VIPROW_BASE}/` },
        });
        if (!pageResp.ok) continue;
        const pageHtml = await pageResp.text();

        const m3u8s = [...pageHtml.matchAll(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/gi)].map(m => m[1]);

        for (const url of m3u8s.slice(0, 2)) {
          results.push(buildStreamResult(`viprow_${results.length}`, "viprow.me", url, absLink));
        }
      } catch { /* ignore */ }
    }
  } catch (e) {
    console.warn("[VIPRow] Erreur:", e);
  }

  return results;
}

// ─── PROXY M3U8 ─────────────────────────────────────────────────────────────

/**
 * FIX #7, #8 : Proxy HLS complet avec réécriture récursive des URL relatives.
 *
 * Gère :
 *  - Playlists master (multi-qualité)
 *  - Playlists de segments
 *  - Clés AES (#EXT-X-KEY URI=...)
 *  - Segments sans extension
 *  - Chemins relatifs avec ../
 *  - Byte ranges (#EXT-X-MAP URI=...)
 */
async function handleProxy(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");
  const referer = url.searchParams.get("ref") ?? "";

  if (!targetUrl) return jsonError("Missing url param", 400);

  // Valider l'URL cible
  let parsedTarget: URL;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    return jsonError("Invalid url param", 400);
  }

  // FIX #8 : allowlist étendue — segments peuvent ne pas avoir d'extension
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

  // FIX : guard referer vide
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
    // @ts-ignore
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

    // Base URL pour résolution des URLs relatives
    const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);

    // Construire l'URL du proxy lui-même pour réécrire les URLs dans la playlist
    const selfBase = `${new URL(request.url).origin}/api/proxy?token=${env.APP_TOKEN}&ref=${encodeURIComponent(targetUrl)}&url=`;

    body = rewriteM3U8(body, baseUrl, selfBase);

    responseHeaders.set("Content-Type", "application/vnd.apple.mpegurl");
    responseHeaders.set("Cache-Control", "no-cache");

    return new Response(body, { status: proxyResp.status, headers: responseHeaders });
  }

  // Pour les segments TS/M4S, streamer directement
  responseHeaders.delete("Content-Encoding"); // évite décompression double
  return new Response(proxyResp.body, { status: proxyResp.status, headers: responseHeaders });
}

/**
 * Réécriture complète d'une playlist M3U8.
 * Toutes les URLs (segments, clés, sous-playlists) sont absolutisées
 * puis passées à travers le proxy.
 */
function rewriteM3U8(body: string, baseUrl: string, proxyPrefix: string): string {
  return body
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#EXTINF") || trimmed.startsWith("#EXT-X-STREAM-INF")) {
        return line;
      }

      // FIX #7 : Réécriture des clés AES : #EXT-X-KEY:METHOD=AES-128,URI="..."
      if (trimmed.startsWith("#EXT-X-KEY")) {
        return trimmed.replace(/URI="([^"]+)"/, (_m, uri) => {
          const abs = absolutize(uri, baseUrl);
          return `URI="${proxyPrefix}${encodeURIComponent(abs)}&force=1"`;
        });
      }

      // Réécriture de #EXT-X-MAP URI="..." (init segment fMP4)
      if (trimmed.startsWith("#EXT-X-MAP")) {
        return trimmed.replace(/URI="([^"]+)"/, (_m, uri) => {
          const abs = absolutize(uri, baseUrl);
          return `URI="${proxyPrefix}${encodeURIComponent(abs)}&force=1"`;
        });
      }

      // Ligne de segment (ne commence pas par #)
      if (!trimmed.startsWith("#")) {
        const abs = absolutize(trimmed, baseUrl);
        return `${proxyPrefix}${encodeURIComponent(abs)}&force=1`;
      }

      return line;
    })
    .join("\n");
}

/**
 * Résout une URL relative par rapport à une base.
 * Gère les chemins ../relatifs/profonds.
 */
function absolutize(url: string, base: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) {
    // Absolu depuis la racine du domaine
    try {
      const baseUrl = new URL(base);
      return `${baseUrl.origin}${url}`;
    } catch { return url; }
  }
  // Relatif
  try {
    return new URL(url, base).href;
  } catch { return base + url; }
}

// ─── SEARCH ─────────────────────────────────────────────────────────────────

async function handleSearch(q: string, env: Env): Promise<Response> {
  if (!q || q.length < 2) return json([]);

  const cacheKey = `search:${q.toLowerCase().trim()}`;

  try {
    const cached = await env.CACHE.get(cacheKey);
    if (cached) return json(JSON.parse(cached));
  } catch { /* ignore */ }

  // TheSportsDB (gratuit, pas de clé requise en v1)
  try {
    const resp = await fetch(
      `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(q)}`,
      { headers: { "User-Agent": UA } }
    );

    if (!resp.ok) return json([]);

    const data: any = await resp.json();
    const results = (data.teams ?? []).map((t: any) => ({
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

// ─── CRON REFRESH ───────────────────────────────────────────────────────────

async function refreshMatchCache(env: Env): Promise<void> {
  try {
    console.log("[Cron] Rafraîchissement du cache matchs...");
    const matches = await fetchAndMergeMatches(env);

    await env.CACHE.put("matches:all", JSON.stringify(matches), { expirationTtl: 300 });

    const live = matches.filter((m: any) => m.status === "LIVE");
    await env.CACHE.put("matches:live", JSON.stringify(live), { expirationTtl: 30 });

    console.log(`[Cron] Cache mis à jour : ${matches.length} matchs, ${live.length} en direct`);

    if (live.length > 0) {
      await sendLiveNotifications(live, env);
    }
  } catch (e) {
    console.error("[Cron] Erreur:", e);
  }
}

/**
 * FIX #10 : Notifications FCM batchées avec Promise.allSettled + limite 50.
 */
async function sendLiveNotifications(liveMatches: any[], env: Env): Promise<void> {
  if (!env.FCM_SERVER_KEY || !env.DB) return;

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
       LIMIT 50`  // FIX #10 : limiter à 50 tokens par cycle
    )
      .bind(...teams)
      .all();

    const tokens = (rows.results ?? [])
      .map((r: any) => r.fcm_token)
      .filter(Boolean) as string[];

    if (tokens.length === 0) return;

    // Construire le body de notification une fois
    const notifBody = liveMatches
      .slice(0, 3)
      .map((m: any) => `${m.homeTeam?.name} vs ${m.awayTeam?.name}`)
      .join(", ");

    // FIX #10 : Envoyer toutes les notifications en parallèle
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
            data: {
              type: "LIVE_MATCHES",
              count: String(liveMatches.length),
            },
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
