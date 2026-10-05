import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const config = JSON.parse(read('vercel.json'));
const base = 'https://promofinder.4ourmedia.com';
function htmlFiles(dir) {
  return readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? htmlFiles(`${dir}${entry.name}/`) : entry.name.endsWith('.html') ? [`${dir}${entry.name}`] : []);
}
const pages = htmlFiles('public/');
const decode = text => text.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
const meta = (html, name) => decode(html.match(new RegExp(`<meta (?:name|property)="${name}" content="([^"]*)"`))?.[1] || '');
const visible = html => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, '');
function resolves(path) {
  const route = config.redirects.find(route => route.source === path) || config.rewrites.find(route => route.source === path);
  const target = route ? route.destination.replace(/^\/public\//, '/') : path;
  const relative = target === '/' ? 'index.html' : target.replace(/^\//, '');
  return [relative, `${relative}.html`, `${relative.replace(/\/$/, '')}/index.html`].some(file => existsSync(new URL(`public/${file}`, root)));
}

test('every static page has unique bounded metadata and complete social cards', () => {
  const titles = new Set();
  const descriptions = new Set();
  for (const path of pages) {
    const html = read(path);
    const title = decode(html.match(/<title>(.*?)<\/title>/s)[1]);
    const description = meta(html, 'description');
    assert.ok(title.length > 0 && title.length < 60, `${path}: title length ${title.length}`);
    assert.ok(description.length > 0 && description.length < 160, `${path}: description length ${description.length}`);
    assert.ok(!titles.has(title), `${path}: duplicate title`);
    assert.ok(!descriptions.has(description), `${path}: duplicate description`);
    titles.add(title); descriptions.add(description);
    const canonical = html.match(/rel="canonical" href="([^"]+)"/)?.[1];
    assert.ok(canonical?.startsWith(base), `${path}: canonical`);
    assert.equal(meta(html, 'og:url'), canonical);
    for (const prefix of ['og', 'twitter']) {
      assert.equal(meta(html, `${prefix}:title`), title, path);
      assert.equal(meta(html, `${prefix}:description`), description, path);
      assert.equal(meta(html, `${prefix}:image`), `${base}/social-preview.png`, path);
      assert.ok(meta(html, `${prefix}:image:alt`), path);
    }
    assert.equal(meta(html, 'twitter:card'), 'summary_large_image');
    assert.ok(resolves(new URL(canonical).pathname), canonical);
  }
});

test('all static pages have one H1, logical headings, alt text, and valid scripts', () => {
  for (const path of pages) {
    const html = read(path);
    const markup = visible(html);
    assert.equal((markup.match(/<h1\b/g) || []).length, 1, path);
    const headings = [...markup.matchAll(/<h([1-6])\b/g)].map(match => Number(match[1]));
    for (let i = 1; i < headings.length; i++) assert.ok(headings[i] <= headings[i - 1] + 1, `${path}: skipped heading`);
    for (const image of markup.matchAll(/<img\b[^>]*>/g)) assert.match(image[0], /\balt\s*=/, path);
    assert.match(html, /name="viewport"/, path);
    for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (script[1].includes('ld+json')) JSON.parse(script[2]);
      else if (!script[1].includes('type="module"')) new vm.Script(script[2], { filename: path });
    }
  }
});

test('internal static links and assets resolve and fragments exist', () => {
  for (const path of pages) {
    const html = visible(read(path));
    for (const match of html.matchAll(/\b(?:href|src)="([^"$]*)"/g)) {
      const href = decode(match[1]);
      if (href.startsWith('#') && href.length > 1) {
        assert.ok(html.includes(`id="${href.slice(1)}"`), `${path}: ${href}`);
      } else if (href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/api/')) {
        const url = new URL(href, base);
        assert.ok(resolves(url.pathname), `${path}: ${href}`);
      }
    }
  }
});

test('sitemap includes every indexable canonical and excludes private pages', () => {
  const locations = [...read('public/sitemap.xml').matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]);
  assert.equal(new Set(locations).size, locations.length);
  for (const path of pages) {
    const html = read(path);
    const canonical = html.match(/rel="canonical" href="([^"]+)"/)[1];
    assert.equal(locations.includes(canonical), !/name="robots" content="noindex/i.test(html), path);
  }
  assert.match(read('public/robots.txt'), /Sitemap: https:\/\/promofinder\.4ourmedia\.com\/sitemap\.xml/);
});

test('guide articles have 400–800 visible words and FAQ schema matching visible content', () => {
  const guides = pages.filter(path => path.startsWith('public/guides/') && path !== 'public/guides/index.html');
  assert.equal(guides.length, 4);
  for (const path of guides) {
    const html = read(path);
    const main = visible(html).match(/<main\b[^>]*>([\s\S]*?)<\/main>/)[1];
    const text = main.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const words = text.split(' ').length;
    assert.ok(words >= 400 && words <= 800, `${path}: ${words} words`);
    const schemas = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1]));
    const nodes = schemas.flatMap(schema => schema['@graph'] || [schema]);
    const faq = nodes.find(node => node['@type'] === 'FAQPage');
    assert.ok(faq?.mainEntity.length, path);
    for (const question of faq.mainEntity) {
      assert.ok(decode(text).includes(decode(question.name)), `${path}: missing visible question`);
      assert.ok(decode(text).includes(decode(question.acceptedAnswer.text)), `${path}: missing visible answer`);
    }
    assert.match(main, /href="\/unlisted"/, path);
  }
});

test('search action pre-fills a supported channel input and ratings are not fabricated', () => {
  const home = read('public/index.html');
  assert.match(home, /unlisted\?channel=\{search_term_string\}/);
  const tool = read('public/unlisted.html');
  assert.match(tool, /"@type": "SoftwareApplication"/);
  assert.match(tool, /get\('channel'\)/);
  assert.doesNotMatch(tool, /aggregateRating/);
  assert.match(config.headers[0].headers.find(header => header.key === 'Content-Security-Policy').value, /connect-src[^;]*https:\/\/formsubmit\.co/);
});
