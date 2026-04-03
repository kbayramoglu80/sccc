const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const News = require('./models/News');
const Source = require('./models/Source');
const gridfs = require('./lib/gridfs');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0'
];
function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getBrowserHeaders(url) {
  const origin = new URL(url).origin;
  return {
    'User-Agent': getRandomUA(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Referer': origin + '/',
    'Cache-Control': 'max-age=0'
  };
}

async function fetchPage(url, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt));
      const response = await axios.get(url, {
        headers: getBrowserHeaders(url),
        timeout: 20000,
        maxRedirects: 5,
        responseType: 'arraybuffer',
        decompress: true
      });

      const contentType = response.headers['content-type'] || '';
      let charset = 'utf-8';
      const charsetMatch = contentType.match(/charset=([^\s;]+)/i);
      if (charsetMatch) {
        charset = charsetMatch[1].toLowerCase();
      }

      const buf = Buffer.from(response.data);
      const htmlPreview = buf.toString('utf-8').substring(0, 2000);
      const metaCharset = htmlPreview.match(/charset=["']?([^"'\s;>]+)/i);
      if (metaCharset) {
        charset = metaCharset[1].toLowerCase();
      }

      const turkishCharsets = ['iso-8859-9', 'windows-1254', 'latin5'];
      if (turkishCharsets.includes(charset)) {
        const { TextDecoder } = require('util');
        const decoder = new TextDecoder(charset);
        return decoder.decode(buf);
      }

      return buf.toString('utf-8');
    } catch (err) {
      lastErr = err;
      console.log(`[Scraper] ${url} deneme ${attempt + 1} başarısız: ${err.message}`);
    }
  }
  throw lastErr;
}

async function downloadImage(imageUrl) {
  if (!imageUrl || imageUrl.startsWith('data:')) return '';

  try {
    const response = await axios.get(imageUrl, {
      headers: {
        'User-Agent': getRandomUA(),
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': new URL(imageUrl).origin + '/'
      },
      timeout: 10000,
      responseType: 'arraybuffer',
      maxRedirects: 5
    });

    const contentType = response.headers['content-type'] || '';

    if (!contentType.includes('image')) {
      console.error(`[Scraper] Görsel değil (${contentType}): ${imageUrl}`);
      return '';
    }

    let ext = '.jpg';
    if (contentType.includes('png')) ext = '.png';
    else if (contentType.includes('webp')) ext = '.webp';
    else if (contentType.includes('gif')) ext = '.gif';
    else {
      const urlExt = path.extname(imageUrl.split('?')[0]).toLowerCase();
      if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(urlExt)) {
        ext = urlExt;
      }
    }

    const filename = Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
    const buf = Buffer.from(response.data);
    const ct = contentType.split(';')[0].trim() || 'image/jpeg';
    const { url } = await gridfs.uploadBuffer(buf, filename, ct);
    return url;
  } catch (err) {
    console.error(`[Scraper] Görsel indirme hatası: ${err.message}`);
    return imageUrl;
  }
}

function normalizeDateValue(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  const direct = new Date(trimmed);
  if (!Number.isNaN(direct.getTime())) return direct;

  const compact = trimmed
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/,/, ' ')
    .trim();

  // dd.mm.yyyy hh:mm or dd/mm/yyyy hh:mm
  const trMatch = compact.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (trMatch) {
    const day = parseInt(trMatch[1], 10);
    const month = parseInt(trMatch[2], 10) - 1;
    let year = parseInt(trMatch[3], 10);
    if (year < 100) year += 2000;
    const hour = trMatch[4] ? parseInt(trMatch[4], 10) : 0;
    const minute = trMatch[5] ? parseInt(trMatch[5], 10) : 0;
    const dt = new Date(year, month, day, hour, minute);
    if (!Number.isNaN(dt.getTime())) return dt;
  }

  return null;
}

function extractPublishedAtFromJsonLd($) {
  $('script[type="application/ld+json"]').each((_, el) => {
    let raw = $(el).html();
    if (!raw) return;
    raw = raw.trim();
    try {
      const data = JSON.parse(raw);
      const list = Array.isArray(data) ? data : [data];
      for (const node of list) {
        if (!node || typeof node !== 'object') continue;
        if (node['@graph'] && Array.isArray(node['@graph'])) {
          for (const g of node['@graph']) {
            const d = g && (g.datePublished || g.dateCreated);
            const parsed = normalizeDateValue(d);
            if (parsed) return parsed;
          }
        }
        const d = node.datePublished || node.dateCreated || node.uploadDate;
        const parsed = normalizeDateValue(d);
        if (parsed) return parsed;
      }
    } catch (_) { /* geçersiz JSON */ }
  });
  return null;
}

function extractPublishedAtFrom$($) {
  const jsonLd = extractPublishedAtFromJsonLd($);
  if (jsonLd) return jsonLd;

  const candidates = [
    $('meta[property="article:published_time"]').attr('content'),
    $('meta[name="article:published_time"]').attr('content'),
    $('meta[property="og:published_time"]').attr('content'),
    $('meta[name="og:published_time"]').attr('content'),
    $('meta[property="og:updated_time"]').attr('content'),
    $('meta[name="pubdate"]').attr('content'),
    $('meta[name="publish-date"]').attr('content'),
    $('meta[name="DC.date.issued"]').attr('content'),
    $('meta[name="dc.date"]').attr('content'),
    $('meta[itemprop="datePublished"]').attr('content'),
    $('time[datetime]').first().attr('datetime'),
    $('time').first().attr('datetime'),
    $('[itemprop="datePublished"]').first().attr('datetime'),
    $('[itemprop="datePublished"]').first().text(),
    $('.post-meta time').first().attr('datetime'),
    $('.entry-meta time').first().attr('datetime'),
    $('.published').first().attr('datetime'),
    $('.date').first().text(),
    $('.tarih').first().text(),
    $('.post-date').first().text(),
    $('.entry-date').first().text(),
    $('[class*="tarih"]').first().text(),
    $('[class*="date"]').first().text()
  ];

  for (const val of candidates) {
    const parsed = normalizeDateValue(val);
    if (parsed) return parsed;
  }
  return null;
}

async function fetchArticlePublishedAt(articleUrl) {
  if (!articleUrl) return null;
  try {
    const html = await fetchPage(articleUrl);
    const $ = cheerio.load(html);
    return extractPublishedAtFrom$($);
  } catch (err) {
    console.log(`[Scraper] Yayın tarihi alınamadı (${articleUrl}): ${err.message}`);
  }
  return null;
}

const DEFAULT_CONTENT_SELECTORS = [
  '[itemprop="articleBody"]',
  'article [itemprop="articleBody"]',
  '.wp-block-post-content',
  'article .entry-content',
  '.entry-content',
  '.post-content',
  '.article-content',
  '.news-content',
  '.newsbody',
  '.news-body',
  '.story-content',
  '.story-body',
  '.haber-detay',
  '.haber-detay-icerik',
  '.haber_icerik',
  '.haber-metni',
  '.haber_metni',
  '.yazi-icerik',
  '.yazi_icerik',
  '.icerik-alani',
  '.icerik_alani',
  '.detay-icerik',
  '.post-text',
  '.post-entry',
  '.news-text',
  '.detail-text',
  '.full-content',
  '.topic-content',
  '.topic .content',
  '#article-content',
  '#story-body',
  '#post-content',
  '#haber-icerik',
  '#icerik',
  '#content .article',
  '.td-post-content',
  '.content-inner',
  '.single-content',
  '.detail-content',
  '.news-detail',
  '.article-body',
  '.post-body',
  'main article',
  'article .post',
  'article .content',
  'main .content',
  '.single-post-content',
  '.site-content article',
  'article'
];

const CONTENT_NOISE_SELECTORS = [
  '.sharedaddy', '.social-share', '.wp-block-share', '.yarpp-related',
  '.related-posts', '.jp-relatedposts', '.jp-related', 'nav', 'footer',
  '.comments', '#comments', '#respond', '.sidebar', 'aside',
  '.widget-area', '#secondary', '.post-navigation', '.navigation',
  '.yarpp', '.addtoany', '.advertisement', '.reklam', '.banner',
  '.author-box', '.post-author', '.tags-list', '.entry-meta',
  '.breadcrumb', '.breadcrumbs', '.yoast-breadcrumbs', '#wpadminbar'
];

function escapeHtmlPlain(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeJsonLdArticleBody(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const t = raw.trim();
  if (!t) return '';
  if (t.startsWith('<')) return t;
  const parts = t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return '<p>' + escapeHtmlPlain(t) + '</p>';
  return parts.map((p) => '<p>' + escapeHtmlPlain(p).replace(/\n/g, '<br>') + '</p>').join('\n');
}

function extractArticleBodyFromJsonLd($) {
  let best = '';
  let bestLen = 0;
  $('script[type="application/ld+json"]').each((_, el) => {
    let raw = $(el).html();
    if (!raw) return;
    raw = raw.trim();
    try {
      const data = JSON.parse(raw);
      const list = Array.isArray(data) ? data : [data];
      for (const node of list) {
        if (!node || typeof node !== 'object') continue;
        const tryBody = (o) => {
          const b = o && o.articleBody;
          if (b && typeof b === 'string') {
            const html = normalizeJsonLdArticleBody(b);
            const len = cheerio.load('<div>' + html + '</div>').text().replace(/\s+/g, ' ').trim().length;
            if (len > bestLen) {
              bestLen = len;
              best = html;
            }
          }
        };
        tryBody(node);
        if (node['@graph'] && Array.isArray(node['@graph'])) {
          for (const g of node['@graph']) tryBody(g);
        }
      }
    } catch (_) { /* atla */ }
  });
  return best;
}

function stripContentNoise(clone$) {
  clone$.find(CONTENT_NOISE_SELECTORS.join(', ')).remove();
  clone$.find('script, style, iframe, noscript, object, svg').remove();
}

function scoreContentHtml(html) {
  if (!html) return 0;
  const $wrap = cheerio.load('<div class="sc">' + html + '</div>', { decodeEntities: false });
  const t = $wrap('.sc').text().replace(/\s+/g, ' ').trim();
  const pCount = $wrap('.sc p').length;
  const brCount = $wrap('.sc br').length;
  return t.length + Math.min(pCount, 40) * 20 + Math.min(brCount, 25) * 4;
}

function extractBodyFromMainFallback($) {
  const main = $('main').first();
  if (!main.length) return '';
  const clone = main.clone();
  stripContentNoise(clone);
  clone.find('header, .entry-header, .page-header, .article-header').first().remove();
  clone.find('h1').first().remove();
  const t = clone.text().replace(/\s+/g, ' ').trim();
  if (t.length < 80) return '';
  return clone.html() || '';
}

function mergeDescriptionLead(description, title, bodyHtml) {
  if (!description || description === title || String(description).trim().length < 40) {
    return bodyHtml || '';
  }
  const bodyLen = bodyHtml
    ? cheerio.load('<div>' + bodyHtml + '</div>').text().replace(/\s+/g, ' ').trim().length
    : 0;
  if (bodyLen >= 200) return bodyHtml || '';
  const lead = `<p class="scraped-lead"><strong>${escapeHtmlPlain(description)}</strong></p>\n`;
  return lead + (bodyHtml || '');
}

function resolveUrlAgainstArticle(href, articleUrl) {
  if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:')) return href;
  try {
    return new URL(href, articleUrl).href;
  } catch {
    return href;
  }
}

function resolveRelativeUrlsInHtml(html, articleUrl) {
  if (!html || !articleUrl) return html || '';
  const $ = cheerio.load('<div id="scraped-content-root">' + html + '</div>', { decodeEntities: false });
  $('#scraped-content-root a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) $(el).attr('href', resolveUrlAgainstArticle(href, articleUrl));
  });
  $('#scraped-content-root img').each((_, el) => {
    const $el = $(el);
    let src = $el.attr('data-src') || $el.attr('data-lazy-src') || $el.attr('data-original') || $el.attr('src');
    if (src && !src.startsWith('data:')) {
      $el.attr('src', resolveUrlAgainstArticle(src, articleUrl));
    }
  });
  return $('#scraped-content-root').html() || '';
}

function extractBodyFrom$($, source) {
  const customSel = source.selectors && String(source.selectors.content || '').trim();
  let customHtml = '';
  if (customSel) {
    $(customSel).each((_, node) => {
      const clone = $(node).clone();
      stripContentNoise(clone);
      const textLen = clone.text().replace(/\s+/g, ' ').trim().length;
      const h = clone.html();
      if (!h || textLen < 30) return;
      if (textLen > (customHtml ? cheerio.load('<div>' + customHtml + '</div>').text().length : 0)) {
        customHtml = h;
      }
    });
  }

  let best = '';
  let bestScore = 0;
  for (const sel of DEFAULT_CONTENT_SELECTORS) {
    $(sel).each((_, node) => {
      const clone = $(node).clone();
      stripContentNoise(clone);
      const textLen = clone.text().replace(/\s+/g, ' ').trim().length;
      if (textLen < 25) return;
      const h = clone.html();
      if (!h) return;
      const sc = scoreContentHtml(h);
      if (sc > bestScore) {
        bestScore = sc;
        best = h;
      }
    });
  }

  const textLenOf = (html) => (html
    ? cheerio.load('<div>' + html + '</div>').text().replace(/\s+/g, ' ').trim().length
    : 0);

  let customTextLen = textLenOf(customHtml);
  let bestTextLen = textLenOf(best);
  if (customTextLen > bestTextLen) {
    best = customHtml;
    bestTextLen = customTextLen;
  }

  let curLen = bestTextLen;
  if (curLen < 120) {
    const fromLd = extractArticleBodyFromJsonLd($);
    const ldLen = textLenOf(fromLd);
    if (fromLd && ldLen > curLen) {
      best = fromLd;
      curLen = ldLen;
    }
  }

  if (curLen < 100) {
    const fromMain = extractBodyFromMainFallback($);
    const mLen = textLenOf(fromMain);
    if (fromMain && mLen > curLen) best = fromMain;
  }

  curLen = textLenOf(best);
  if (curLen < 80) {
    const ogDesc = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content');
    const d = ogDesc ? String(ogDesc).trim() : '';
    if (d.length > 90) {
      const para = '<p>' + escapeHtmlPlain(d) + '</p>';
      if (textLenOf(para) > curLen) best = para;
    }
  }

  return best || customHtml || '';
}

async function fetchArticleDetail(articleUrl, source) {
  try {
    const html = await fetchPage(articleUrl);
    const $ = cheerio.load(html);
    const publishedAt = extractPublishedAtFrom$($);
    let bodyHtml = extractBodyFrom$($, source);
    bodyHtml = resolveRelativeUrlsInHtml(bodyHtml, articleUrl);
    return { publishedAt, bodyHtml };
  } catch (err) {
    console.log(`[Scraper] Detay sayfası alınamadı (${articleUrl}): ${err.message}`);
    return { publishedAt: null, bodyHtml: '' };
  }
}

async function processContentImages(html, articleUrl) {
  if (!html || !articleUrl) return html || '';
  const $ = cheerio.load('<div id="img-root">' + html + '</div>', { decodeEntities: false });
  const nodes = $('#img-root img').toArray();
  for (const node of nodes) {
    const el = $(node);
    let src = el.attr('data-src') || el.attr('data-lazy-src') || el.attr('data-original') || el.attr('src') || '';
    if (!src || src.startsWith('data:')) continue;
    let absolute;
    try {
      absolute = new URL(src, articleUrl).href;
    } catch {
      continue;
    }
    if (/logo|icon|avatar|emoji|1x1|spacer|pixel|tracking/i.test(absolute)) continue;
    const local = await downloadImage(absolute);
    if (local) {
      el.attr('src', local);
      el.removeAttr('data-src');
      el.removeAttr('data-lazy-src');
      el.removeAttr('data-original');
    }
  }
  return $('#img-root').html() || '';
}

/**
 * Liste + detay + görseller — kaydetmeden önce ortak zenginleştirme
 */
async function enrichArticleFromSource(article, source) {
  let imageUrl = article.image || '';

  if (article.link) {
    const needsThumb = !imageUrl || imageUrl === '' || imageUrl.includes('-s.jpg') || imageUrl.includes('thumb');
    if (needsThumb) {
      try {
        const better = await fetchImageFromArticlePage(article.link);
        if (better) imageUrl = better;
      } catch (_) { /* ignore */ }
    }
  }

  let publishedAt = null;
  let bodyHtml = '';
  if (article.link) {
    const detail = await fetchArticleDetail(article.link, source);
    publishedAt = detail.publishedAt;
    bodyHtml = detail.bodyHtml || '';
    if (bodyHtml) {
      bodyHtml = await processContentImages(bodyHtml, article.link);
    }
    bodyHtml = mergeDescriptionLead(article.description, article.title, bodyHtml);
  }

  if (imageUrl && imageUrl.startsWith('http')) {
    const dl = await downloadImage(imageUrl);
    if (dl) imageUrl = dl;
  }

  const attribution = article.link
    ? `<p><small>Kaynak: <a href="${article.link}" target="_blank" rel="noopener noreferrer">${source.name}</a></small></p>`
    : '';

  const content = bodyHtml ? `${bodyHtml}\n${attribution}` : (article.link ? attribution : '');

  return {
    title: article.title,
    description: article.description,
    category: article.category,
    image: imageUrl || '',
    publishedAt,
    content
  };
}

function resolveUrl(href, baseUrl) {
  if (!href) return '';
  if (href.startsWith('http')) return href;
  if (href.startsWith('//')) return 'https:' + href;
  if (baseUrl) {
    const base = baseUrl.replace(/\/$/, '');
    const path = href.startsWith('/') ? href : '/' + href;
    return base + path;
  }
  return href;
}

function parseSrcsetFirst(url) {
  if (!url || typeof url !== 'string') return '';
  const first = url.split(',')[0].trim();
  return first.split(/\s+/)[0] || '';
}

/**
 * Liste kutusundaki img / picture için mümkün olan en iyi görsel URL'si
 */
function resolveImageUrl(imgEl, $, baseUrl) {
  if (!imgEl || !imgEl.length) return '';

  let src = imgEl.attr('data-src') ||
    imgEl.attr('data-original') ||
    imgEl.attr('data-lazyload') ||
    imgEl.attr('data-lazy-src') ||
    imgEl.attr('data-lazy') ||
    imgEl.attr('data-url');

  if (!src) {
    const ds = imgEl.attr('data-srcset') || imgEl.attr('data-src-set');
    src = parseSrcsetFirst(ds);
  }
  if (!src) {
    const ss = imgEl.attr('srcset');
    src = parseSrcsetFirst(ss);
  }
  if (!src) src = imgEl.attr('src') || '';

  if ((!src || src.startsWith('data:')) && imgEl.length) {
    const pic = imgEl.closest('picture');
    if (pic.length) {
      const s = pic.find('source').first().attr('srcset');
      src = parseSrcsetFirst(s) || src;
    }
  }

  if (!src || src.startsWith('data:')) return '';

  let resolved;
  try {
    resolved = new URL(src, baseUrl || 'https://example.com').href;
  } catch {
    resolved = resolveUrl(src, baseUrl);
  }
  return upgradeImageUrl(resolved);
}

function findFirstImageInCard($el, $, baseUrl) {
  const imgs = $el.find('img');
  for (let i = 0; i < imgs.length; i++) {
    const u = resolveImageUrl($(imgs[i]), $, baseUrl);
    if (u) return u;
  }
  const pic = $el.find('picture img').first();
  if (pic.length) {
    const u = resolveImageUrl(pic, $, baseUrl);
    if (u) return u;
  }
  return '';
}

function upgradeImageUrl(url) {
  if (!url) return '';

  const placeholders = ['bos.png', 'mask-', 'placeholder', 'default-image', 'no-image'];
  if (placeholders.some(p => url.includes(p))) return '';

  return url;
}

function cleanTitle(text) {
  return text.replace(/\s+/g, ' ').trim();
}

const CATEGORY_KEYWORDS = {
  'Spor': [
    'spor', 'maç', 'gol', 'futbol', 'basketbol', 'voleybol', 'şampiyon',
    'lig', 'takım', 'transfer', 'turnuva', 'milli takım', 'antrenör',
    'stadyum', 'güreş', 'boks', 'atletizm', 'badminton', 'karate',
    'kick boks', 'muay thai', 'forma', 'deplasman', 'galibiyet', 'mağlubiyet',
    'puan', 'kupa', 'sampiyona', 'sporcu', 'teknik direktör', 'hakem',
    'penaltı', 'yarış', 'koşu', 'yüzme', 'tenis', 'beşiktaş', 'galatasaray',
    'fenerbahçe', 'trabzonspor', 'çorluspor', 'fevzipaşa spor'
  ],
  'Ekonomi': [
    'ekonomi', 'borsa', 'dolar', 'euro', 'faiz', 'enflasyon', 'ihracat',
    'ithalat', 'yatırım', 'bütçe', 'vergi', 'ticaret', 'sanayi', 'piyasa',
    'bist', 'merkez bankası', 'ticaret odası', 'tso', 'osb', 'fabrika',
    'istihdam', 'işsizlik', 'maaş', 'zam', 'fiyat', 'ödenek', 'döviz',
    'halk et', 'tüketici', 'promosyon', 'kredi'
  ],
  'Siyaset': [
    'siyaset', 'milletvekili', 'belediye başkanı', 'parti', 'ak parti',
    'chp', 'mhp', 'iyi parti', 'meclis', 'cumhurbaşkanı', 'bakan',
    'seçim', 'oy', 'siyasi', 'vali', 'kaymakam', 'vekil', 'başkan adayı',
    'genel kurul', 'kongre', 'tbmm', 'muhalefet', 'iktidar', 'aday',
    'büyükşehir belediye'
  ],
  'Sağlık': [
    'sağlık', 'hastane', 'doktor', 'ameliyat', 'tedavi', 'hastalık',
    'kanser', 'grip', 'covid', 'aşı', 'ilaç', 'diş', 'enfeksiyon',
    'kalp', 'tansiyon', 'diyabet', 'obezite', 'beslenme', 'vitamin',
    'psikolog', 'terapi', 'bel ağrısı', 'kolon', 'ağız', 'sahur',
    'oruç', 'zayıflatan'
  ],
  'Yaşam': [
    'yaşam', 'kültür', 'sanat', 'eğitim', 'okul', 'öğrenci', 'ramazan',
    'bayram', 'festival', 'gezi', 'tatil', 'moda', 'yemek', 'tarih',
    'müze', 'sergi', 'konser', 'tiyatro', 'sinema', 'kitap', 'fener alayı',
    'bedesten', 'iftar', 'sahur', 'davulcu', 'ev modası', 'çocuk hakları'
  ],
  'Son Dakika': [
    'son dakika', 'flaş', 'acil', 'deprem', 'sel', 'kaza', 'patlama',
    'yangın', 'öldürdü', 'bıçak', 'cinayet', 'tutuklama', 'operasyon',
    'yaralı', 'hayatını kaybetti', 'saldırı', 'ölü', 'gözaltı',
    'kaçak', 'uyuşturucu', 'hırsızlık', 'gasp', 'silahlı'
  ]
};

function detectCategory(title, description, siteCategory) {
  const text = (title + ' ' + description).toLowerCase().replace(/İ/g, 'i').replace(/I/g, 'ı');

  if (siteCategory && siteCategory !== 'Gündem') {
    const validCats = ['Son Dakika', 'Gündem', 'Ekonomi', 'Spor', 'Siyaset', 'Yaşam', 'Sağlık'];
    const normalized = siteCategory.trim();
    if (validCats.includes(normalized)) return normalized;

    const siteMap = {
      'asayiş': 'Son Dakika', 'asayis': 'Son Dakika',
      'spor haber': 'Spor', 'spor': 'Spor',
      'ekonomi': 'Ekonomi',
      'siyaset': 'Siyaset',
      'sağlık': 'Sağlık', 'saglik': 'Sağlık',
      'yaşam': 'Yaşam', 'yasam': 'Yaşam',
      'eğitim': 'Yaşam', 'egitim': 'Yaşam',
      'teknoloji': 'Gündem',
      'çorlu haber': 'Gündem', 'trakya haber': 'Gündem', 'ergene haber': 'Gündem',
      'gündem': 'Gündem', 'gundem': 'Gündem'
    };
    const mapped = siteMap[normalized.toLowerCase()];
    if (mapped) return mapped;
  }

  let bestCat = 'Gündem';
  let bestScore = 0;

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (text.includes(kw.toLowerCase())) {
        score += kw.includes(' ') ? 3 : 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestCat = category;
    }
  }

  return bestCat;
}

function collectArticlesFromListPage($, source, baseUrl, results, seenTitles, seenLinks) {
  const articles = $(source.selectors.articleList);

  articles.each((i, el) => {
    try {
      const $el = $(el);

      const titleEl = source.selectors.title ? $el.find(source.selectors.title) : $el;
      const title = cleanTitle(titleEl.first().text());
      if (!title || title.length < 3) return;

      if (seenTitles.has(title)) return;

      let description = '';
      if (source.selectors.description) {
        description = cleanTitle($el.find(source.selectors.description).first().text());
      }
      if (!description) {
        description = title;
      }

      let image = '';
      if (source.selectors.image) {
        const imgEl = $el.find(source.selectors.image).first();
        if (imgEl.length) {
          image = imgEl.is('img')
            ? resolveImageUrl(imgEl, $, baseUrl)
            : resolveUrl(imgEl.attr('href') || '', baseUrl);
        }
      }
      if (!image) {
        image = findFirstImageInCard($el, $, baseUrl);
      }

      let link = '';
      if (source.selectors.link) {
        if (source.selectors.link === '_self') {
          link = resolveUrl($el.attr('href') || '', baseUrl);
        } else {
          const linkEl = $el.find(source.selectors.link).first();
          link = resolveUrl(linkEl.attr('href') || '', baseUrl);
        }
      }

      if (link && seenLinks.has(link)) return;
      if (link) seenLinks.add(link);

      seenTitles.add(title);

      let siteCategory = '';
      if (source.selectors.category) {
        siteCategory = cleanTitle($el.find(source.selectors.category).first().text());
      }

      const category = detectCategory(title, description, siteCategory);
      results.push({ title, description, image, link, category });
    } catch (err) {
      // skip malformed article
    }
  });
}

function resolveRssUrl(source) {
  try {
    const src = String(source.url || '').trim();
    if (!src) return null;
    const host = new URL(src).hostname.replace(/^www\./, '');
    if (host.includes('ergenehaber.com')) return 'https://www.ergenehaber.com/rss';
    if (host.includes('devrimgazetesi.com.tr')) return 'https://www.devrimgazetesi.com.tr/rss';
    return new URL('/rss', src).href;
  } catch {
    return null;
  }
}

function collectArticlesFromRss(xml, source, results, seenTitles, seenLinks) {
  const $ = cheerio.load(xml, { xmlMode: true });
  $('item').each((_, el) => {
    const $item = $(el);
    const title = cleanTitle($item.find('title').first().text());
    const link = resolveUrl(cleanTitle($item.find('link').first().text()), source.baseUrl || source.url || '');
    if (!title || title.length < 3) return;
    if (seenTitles.has(title)) return;
    if (link && seenLinks.has(link)) return;

    let description = cleanTitle($item.find('description').first().text());
    if (!description) description = title;

    const enclosure = $item.find('enclosure').first();
    const media = $item.find('media\\:content').first();
    const image = enclosure.attr('url') || media.attr('url') || '';
    const siteCategory = cleanTitle($item.find('category').first().text());
    const category = detectCategory(title, description, siteCategory);

    seenTitles.add(title);
    if (link) seenLinks.add(link);
    results.push({ title, description, image, link, category });
  });
}

async function scrapeSource(source) {
  const results = [];
  const seenTitles = new Set();
  const seenLinks = new Set();
  const visitedListUrls = new Set();

  const diagnostics = {
    sourceUrl: source.url,
    articleListSelector: source.selectors && source.selectors.articleList,
    firstPageListMatches: null,
    firstPageHtmlLength: null,
    pagesScanned: 0,
    totalParsedArticles: 0,
    fetchError: null,
    selectorError: null
  };

  const maxPages = 30;
  let listUrl = source.url;
  let pageNum = 0;

  const listSel = source.selectors && String(source.selectors.articleList || '').trim();
  if (!source.url || !String(source.url).trim()) {
    diagnostics.fetchError = 'Kaynakta liste URL boş. Kaynağı düzenleyip tam adres girin (https://…).';
    diagnostics.firstPageListMatches = 0;
    return { articles: results, diagnostics };
  }
  if (!listSel) {
    diagnostics.fetchError = 'Haber listesi CSS seçicisi boş. Sol formdan kaynağı düzenleyip kaydedin.';
    diagnostics.firstPageListMatches = 0;
    return { articles: results, diagnostics };
  }

  try {
    let firstBase;
    try {
      firstBase = (source.baseUrl && String(source.baseUrl).trim())
        ? String(source.baseUrl).replace(/\/$/, '')
        : new URL(source.url).origin;
    } catch (urlErr) {
      diagnostics.fetchError = `Liste URL geçersiz: ${urlErr.message}`;
      diagnostics.firstPageListMatches = 0;
      return { articles: results, diagnostics };
    }

    while (listUrl && pageNum < maxPages) {
      if (visitedListUrls.has(listUrl)) break;
      visitedListUrls.add(listUrl);

      const html = await fetchPage(listUrl);
      const $ = cheerio.load(html);
      const baseUrl = (source.baseUrl && String(source.baseUrl).trim())
        ? String(source.baseUrl).replace(/\/$/, '')
        : new URL(listUrl).origin;

      if (diagnostics.firstPageHtmlLength === null) {
        diagnostics.firstPageHtmlLength = typeof html === 'string' ? html.length : 0;
      }

      if (diagnostics.firstPageListMatches === null) {
        try {
          diagnostics.firstPageListMatches = $(listSel).length;
        } catch (e) {
          diagnostics.firstPageListMatches = -1;
          diagnostics.selectorError = e.message;
        }
      }

      collectArticlesFromListPage($, source, baseUrl, results, seenTitles, seenLinks);

      pageNum += 1;
      diagnostics.pagesScanned = visitedListUrls.size;
      diagnostics.totalParsedArticles = results.length;

      const pagSel = source.selectors && String(source.selectors.paginationNext || '').trim();
      if (!pagSel) break;

      const nextEl = $(pagSel).first();
      let nextHref = nextEl.attr('href');
      if (!nextHref && nextEl.is('a')) nextHref = nextEl.attr('href');
      if (!nextHref) nextHref = nextEl.find('a').first().attr('href');

      if (!nextHref) break;

      let nextUrl;
      try {
        nextUrl = new URL(nextHref, listUrl).href;
      } catch {
        nextUrl = resolveUrl(nextHref, firstBase);
      }
      if (!nextUrl || nextUrl === listUrl || visitedListUrls.has(nextUrl)) break;

      listUrl = nextUrl;
      await new Promise((r) => setTimeout(r, 400));
    }

    if (results.length === 0) {
      const rssUrl = resolveRssUrl(source);
      if (rssUrl) {
        try {
          const rssXml = await fetchPage(rssUrl, 1);
          collectArticlesFromRss(rssXml, source, results, seenTitles, seenLinks);
          diagnostics.rssFallback = { used: true, rssUrl, parsedCount: results.length };
        } catch (rssErr) {
          diagnostics.rssFallback = { used: true, rssUrl, error: rssErr.message };
        }
      } else {
        diagnostics.rssFallback = { used: false };
      }
    } else {
      diagnostics.rssFallback = { used: false };
    }
  } catch (err) {
    diagnostics.fetchError = err.message || String(err);
    if (diagnostics.firstPageListMatches == null) diagnostics.firstPageListMatches = 0;
    console.error(`[Scraper] ${source.name} hatası:`, err.message);
    return { articles: results, diagnostics };
  }

  diagnostics.pagesScanned = visitedListUrls.size;
  diagnostics.totalParsedArticles = results.length;
  if (diagnostics.firstPageListMatches == null) diagnostics.firstPageListMatches = 0;

  return { articles: results, diagnostics };
}

function pickOgImageFrom$($, pageUrl) {
  const baseUrl = new URL(pageUrl).origin;
  const metas = [
    () => $('meta[property="og:image:secure_url"]').attr('content'),
    () => $('meta[property="og:image"]').attr('content'),
    () => $('meta[name="twitter:image"]').attr('content'),
    () => $('meta[name="twitter:image:src"]').attr('content'),
    () => $('link[rel="image_src"]').attr('href')
  ];
  for (const get of metas) {
    const raw = get();
    if (raw && String(raw).trim()) {
      const u = upgradeImageUrl(resolveUrl(String(raw).trim(), baseUrl));
      if (u) return u;
    }
  }
  return '';
}

/**
 * Tek istek: önizleme için tarih + kapak görseli (og:image)
 */
async function fetchArticleMeta(articleUrl) {
  try {
    const html = await fetchPage(articleUrl);
    const $ = cheerio.load(html);
    const publishedAt = extractPublishedAtFrom$($);
    const previewImage = pickOgImageFrom$($, articleUrl);
    return { publishedAt, previewImage };
  } catch (e) {
    return { publishedAt: null, previewImage: '' };
  }
}

async function fetchImageFromArticlePage(articleUrl) {
  try {
    const html = await fetchPage(articleUrl);
    const $ = cheerio.load(html);
    const baseUrl = new URL(articleUrl).origin;

    const og = pickOgImageFrom$($, articleUrl);
    if (og) return og;

    const selectors = [
      '.wp-post-image',
      '.news-detail img', '.article-img img', '.post-img img',
      '.content img', 'article img', '.detail img',
      '.haber-detay img', '.news-image img',
      '.post-thumbnail img', '.featured-image img',
      '.td-module-thumb img', '.featured-image img'
    ];

    for (const sel of selectors) {
      const img = $(sel).first();
      if (img.length) {
        const u = resolveImageUrl(img, $, baseUrl);
        if (u) return u;
        const src = img.attr('data-src') || img.attr('src') || '';
        if (src && !src.startsWith('data:') && !/logo|icon|avatar|bos\.png/i.test(src)) {
          return upgradeImageUrl(resolveUrl(src, baseUrl));
        }
      }
    }
  } catch (e) { /* ignore */ }
  return '';
}

async function scrapeAndSave(sourceId) {
  const source = await Source.findById(sourceId);
  if (!source) throw new Error('Kaynak bulunamadı');

  const { articles } = await scrapeSource(source);
  let savedCount = 0;

  for (const article of articles) {
    const exists = await News.findOne({ title: article.title });
    if (exists) continue;

    const enriched = await enrichArticleFromSource(article, source);

    await News.create({
      title: enriched.title,
      description: enriched.description,
      content: enriched.content,
      category: enriched.category,
      categories: [enriched.category || 'Gündem'],
      image: enriched.image || '',
      publishedAt: enriched.publishedAt,
      placement: 'none',
      featured: false
    });
    savedCount++;

    await new Promise((r) => setTimeout(r, 200));
  }

  await Source.findByIdAndUpdate(sourceId, {
    lastScrapedAt: new Date(),
    lastScrapedCount: savedCount
  });

  return { total: articles.length, saved: savedCount, source: source.name };
}

async function scrapeAll() {
  const sources = await Source.find({ active: true });
  const results = [];

  for (const source of sources) {
    try {
      const result = await scrapeAndSave(source._id);
      results.push(result);
    } catch (err) {
      results.push({ source: source.name, error: err.message, total: 0, saved: 0 });
    }
  }

  return results;
}

async function previewSource(source) {
  const { articles, diagnostics } = await scrapeSource(source);
  for (const article of articles) {
    if (!article.link) continue;
    const meta = await fetchArticleMeta(article.link);
    article.publishedAt = meta.publishedAt;
    if (!article.image && meta.previewImage) {
      article.image = meta.previewImage;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return { articles, diagnostics };
}

module.exports = { scrapeAndSave, scrapeAll, previewSource, enrichArticleFromSource };
