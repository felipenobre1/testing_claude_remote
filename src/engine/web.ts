// Real-world web pages, perceived through the game.
//
// When the player shares a link in a conversation, the backend (never the model) fetches it once,
// stores a text snapshot, and links it to an event observed only by the conversation participants.
// NPCs then see the page as it was when they opened it.

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: 'ok' | 'error';
  title: string | null;
  text: string;
  error: string | null;
}

export interface PageFetcher {
  fetch(url: string): Promise<FetchedPage>;
}

const TLDS = 'com|it|io|org|net|eu|co|ai|app|dev|me|xyz|uk|de|fr|es|ch|info|biz|tech|store|shop|site|online';
const URL_RE = new RegExp(
  String.raw`\b((?:https?:\/\/)[^\s<>"')\]]+|(?:www\.)[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s<>"')\]]*)?|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:${TLDS})(?:\/[^\s<>"')\]]*)?)`,
  'gi',
);

/** URLs in a piece of observable text, normalised to https:// when no scheme was given. */
export function extractUrls(text: string, max = 2): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    let u = m[1]!.replace(/[.,;:!?]+$/, '');
    if (/@/.test(u) || text[m.index! - 1] === '@') continue; // e-mail addresses
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    if (!out.includes(u)) out.push(u);
    if (out.length >= max) break;
  }
  return out;
}

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i;

export function checkFetchable(url: string, allowPrivateHosts = false): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'not a valid URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `unsupported scheme ${u.protocol}`;
  if (!allowPrivateHosts && PRIVATE_HOST.test(u.hostname)) return 'private or local address';
  return null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** Readable text of an HTML page: title, meta description, visible body text. */
export function htmlToText(html: string): { title: string | null; text: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const description = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1]
    ?? html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i)?.[1];
  const body = (html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article|\/tr|\/header|\/footer)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ');
  const lines = decode(body).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const text = [description ? decode(description).trim() : '', ...lines].filter(Boolean).join('\n');
  return { title: title ? decode(title).replace(/\s+/g, ' ').trim() || null : null, text };
}

/** Plain HTTP fetcher: http(s) only, no private hosts, manual redirects, size/time limits. */
export class HttpPageFetcher implements PageFetcher {
  private opts: { timeoutMs: number; maxBytes: number; maxChars: number; allowPrivateHosts: boolean };

  constructor(opts: Partial<HttpPageFetcher['opts']> = {}) {
    this.opts = { timeoutMs: 10_000, maxBytes: 1_000_000, maxChars: 8_000, allowPrivateHosts: false, ...opts };
  }

  async fetch(url: string): Promise<FetchedPage> {
    const fail = (error: string, finalUrl = url): FetchedPage => ({ url, finalUrl, status: 'error', title: null, text: '', error });
    let current = url;
    try {
      for (let hop = 0; hop < 5; hop++) {
        const bad = checkFetchable(current, this.opts.allowPrivateHosts);
        if (bad) return fail(bad, current);
        const res = await fetch(current, {
          redirect: 'manual',
          signal: AbortSignal.timeout(this.opts.timeoutMs),
          headers: { 'user-agent': 'Mozilla/5.0 (compatible; StartupSim/0.1)', accept: 'text/html,text/plain;q=0.9' },
        });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          current = new URL(res.headers.get('location')!, current).toString();
          continue;
        }
        if (!res.ok) return fail(`HTTP ${res.status}`, current);
        const type = res.headers.get('content-type') ?? '';
        if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) return fail(`unsupported content type ${type || '(none)'}`, current);
        const raw = await readCapped(res, this.opts.maxBytes);
        const page = /html/i.test(type) ? htmlToText(raw) : { title: null, text: raw.trim() };
        return { url, finalUrl: current, status: 'ok', title: page.title, text: page.text.slice(0, this.opts.maxChars), error: null };
      }
      return fail('too many redirects', current);
    } catch (e) {
      // Node's fetch reports network failures as "fetch failed"; the useful reason is in `cause`.
      const cause = e instanceof Error ? (e.cause as { code?: string; message?: string } | undefined) : undefined;
      const msg = e instanceof Error
        ? e.name === 'TimeoutError' ? 'timed out' : cause ? `${e.message}: ${cause.code ?? ''} ${cause.message ?? ''}`.trim() : e.message
        : String(e);
      return fail(msg, current);
    }
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= maxBytes) {
      await reader.cancel();
      break;
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, maxBytes));
}
