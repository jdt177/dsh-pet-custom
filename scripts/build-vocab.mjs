#!/usr/bin/env node
/**
 * dsh-pet 单词词库构建（一次性、产物入库、运行期离线）
 *
 *   node scripts/build-vocab.mjs --cet6 [--input <path/to/words.json>]
 *   node scripts/build-vocab.mjs --pro  [--limit 2000]
 *   node scripts/build-vocab.mjs --verify
 *
 * 产物：assets/vocab/{cet6.json, pro.json, meta.json, pro.report.json}
 *
 * 数据来源与许可：
 *   · CET-6 词表：https://github.com/zhuran305-web/dsh-cet-vocab (MIT)，由 ECDICT 按 cet 标签裁剪
 *   · ECDICT StarDict（专业词中文释义/音标/词频）：https://github.com/skywind3000/ECDICT (MIT)
 *   · BioWordlists（专业词英文术语补充）：https://zenodo.org/records/7794768 (CC0)
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..');
const OUT_DIR = join(PLUGIN_ROOT, 'assets', 'vocab');
const BUILD_DIR = process.env.VOCAB_BUILD_DIR || 'F:/Harness/test/refs/vocab-build';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argOf = (f, d = null) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const log = (...a) => console.log('[build-vocab]', ...a);

/** 专业强关键词：必须命中（[医]/[生]/[化]/[遗] 标签只作加分，不能单独成立） */
const STRONG_KEYWORDS = [
  '基因', '基因组', '转录', '翻译', '复制', '剪接', '外显子', '内含子', '启动子', '增强子', '染色体', '染色质', '组蛋白',
  '甲基化', '乙酰化', '表观', '核酸', '核苷酸', '碱基', '密码子', '氨基酸', '蛋白质', '蛋白', '酶', '肽', '多肽', '受体', '配体',
  '信号', '通路', '磷酸化', '细胞', '细胞器', '线粒体', '核糖体', '内质网', '溶酶体', '胞', '凋亡', '自噬', '有丝分裂', '减数',
  '突变', '变异', '多态性', '等位基因', '易位', '拷贝数', '融合', '质粒', '载体', '引物', '探针', '杂合', '纯合',
  '测序', '比对', '注释', '组装', '转录组', '蛋白组', '代谢组', '生物信息', '富集', '聚类', '差异表达', '变异位点',
  '肿瘤', '癌', '致癌', '恶性', '转移', '浸润', '化疗', '放疗', '靶向', '耐药', '预后', '活检', '分期', '分级',
  '免疫', '抗体', '抗原', '微环境', '异质性',
  '临床', '诊断', '治疗', '药物', '剂量', '药代', '药效', '病理', '生理', '解剖', '症状', '综合征', '炎症', '感染', '病毒', '细菌',
];
const MIN_FREQ_RANK = 3000;

const WORD_RE = /^[a-z][a-z'-]{2,24}$/;
const isCleanWord = (w) => {
  if (typeof w !== 'string') return false;
  const s = w.trim().toLowerCase();
  if (!WORD_RE.test(s)) return false;
  if (/\d/.test(s)) return false;
  if (/^[A-Z]{2,}$/.test(w.trim())) return false;
  return true;
};
const cleanZh = (t) => {
  if (!t) return '';
  let s = String(t).replace(/\\n/g, '\n').replace(/\r/g, '');
  s = s.replace(/\[[^\]]{1,8}\]/g, ' ');
  s = s.replace(/^[a-z]+\.\s*/gim, ' ');
  s = s.replace(/[a-z]+\.\s*/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/[;；]/g, '，');
  return s.slice(0, 60);
};
const guessPos = (t) => {
  const m = String(t || '').match(/\b(n|v|vt|vi|a|adj|ad|adv|prep|conj|pron|num|art|int)\./i);
  return m ? m[1].toLowerCase() + '.' : '';
};
const normPhone = (p) => {
  const s = String(p || '').trim();
  if (!s) return '';
  return s.startsWith('/') || s.startsWith('[') ? s : '/' + s + '/';
};
const ensureOutDir = () => {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
};

// ---------------- CET-6 ----------------
function buildCet6(inputPath) {
  const src = inputPath || join(BUILD_DIR, 'cet6-raw.json');
  if (!existsSync(src)) {
    console.error(`[build-vocab] 找不到 CET-6 源文件：${src}`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(src, 'utf8'));
  const arr = Array.isArray(raw) ? raw : raw.words || raw.entries || [];
  const seen = new Set();
  const words = [];
  for (const e of arr) {
    const w = String(e.w || e.word || '').trim();
    if (!w || seen.has(w.toLowerCase())) continue;
    const zh = cleanZh(e.t || e.translation || e.definition || '');
    if (!zh) continue;
    seen.add(w.toLowerCase());
    words.push({
      w,
      ph: normPhone(e.p || e.phonetic),
      pos: guessPos(e.t || ''),
      zh,
      freq: Number(e.f || e.b || 0) || 999999,
      tags: ['cet6'],
    });
  }
  words.sort((a, b) => a.freq - b.freq);
  const book = {
    version: 1,
    book: 'cet6',
    label: '六级',
    count: words.length,
    generatedAt: new Date().toISOString().slice(0, 10),
    source: 'dsh-cet-vocab (MIT) ← ECDICT (MIT)',
    words,
  };
  ensureOutDir();
  writeFileSync(join(OUT_DIR, 'cet6.json'), JSON.stringify(book), 'utf8');
  log(`cet6.json 写出 ${words.length} 词 → ${join(OUT_DIR, 'cet6.json')}`);
  return book;
}

// ---------------- StarDict 解析 ----------------
function loadStardict(dirBase) {
  const idxPath = dirBase + '.idx';
  const dictPath = dirBase + '.dict';
  if (!existsSync(idxPath) || !existsSync(dictPath)) {
    console.error(`[build-vocab] 找不到 StarDict：${idxPath} / ${dictPath}`);
    process.exit(1);
  }
  const idx = readFileSync(idxPath);
  const dict = readFileSync(dictPath);
  const entries = [];
  let pos = 0;
  while (pos < idx.length) {
    const end = idx.indexOf(0, pos);
    if (end < 0) break;
    const word = idx.subarray(pos, end).toString('utf8');
    const offset = idx.readUInt32BE(end + 1);
    const size = idx.readUInt32BE(end + 5);
    entries.push({ word, offset, size });
    pos = end + 9;
  }
  return { entries, dict };
}
const NON_DOMAIN_BAD = [/^\[地名\]/, /^\[人名\]/, /^\[网络\]/];
function parseStardictBody(body) {
  const lines = String(body || '').split('\n');
  let ph = '';
  let freq = 999999;
  const zhLines = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    const fm = t.match(/^\(([^)]{1,40})\)$/);
    if (fm) {
      const parts = fm[1].split('/');
      const num = (s) => Number(String(s).replace(/[^\d]/g, '')) || 0;
      const n = num(parts[0]) || num(parts[1]);
      if (n > 0) freq = n;
      continue;
    }
    const phm = t.match(/^\*?\[([^\]]{1,40})\]/);
    if (phm && !/[\u4e00-\u9fa5]/.test(phm[1])) {
      ph = '/' + phm[1].trim() + '/';
      continue;
    }
    zhLines.push(t);
  }
  return { ph, freq, zhLines };
}
const mergedZh = (lines) =>
  lines
    .map((l) => l.replace(/\[[^\]]{1,8}\]/g, ' '))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

// ---------------- 专业词 ----------------
async function buildPro(opts) {
  const stardictBase = opts.ecdict || join(BUILD_DIR, 'ecdict', 'stardict-ecdict-2.4.2', 'stardict-ecdict-2.4.2');
  const bwDir = opts.biowordlists || BUILD_DIR;
  const limit = Number(opts.limit) || 2000;

  const cetSet = new Set();
  const cetPath = join(OUT_DIR, 'cet6.json');
  if (existsSync(cetPath)) {
    try {
      for (const w of JSON.parse(readFileSync(cetPath, 'utf8')).words || []) cetSet.add(String(w.w).toLowerCase());
    } catch {
      /* ignore */
    }
  }
  log(`CET6 已收 ${cetSet.size} 词，pro 排除这些词`);

  const { entries, dict } = loadStardict(stardictBase);
  log(`StarDict 载入 ${entries.length} 条`);

  const hits = [];
  let scanned = 0;
  for (const e of entries) {
    scanned++;
    if (!isCleanWord(e.word)) continue;
    if (cetSet.has(e.word.toLowerCase())) continue;
    const body = dict.subarray(e.offset, e.offset + e.size).toString('utf8');
    const { ph, freq, zhLines } = parseStardictBody(body);
    if (!zhLines.length) continue;
    const joined = zhLines.join(' ');
    if (freq < MIN_FREQ_RANK) continue;
    const matched = STRONG_KEYWORDS.filter((k) => joined.includes(k));
    if (!matched.length) continue;
    const hasDomainTag = /\[(医|生|化|遗)\]/.test(joined);
    // 判定：有专业标签 或 命中≥2 个强关键词（只看标签会漏 apoptosis；只看关键词会混进 commentator/backup/cleaning）
    if (!hasDomainTag && matched.length < 2) continue;
    if (!hasDomainTag && NON_DOMAIN_BAD.some((re) => re.test(joined))) continue;
    const zh = cleanZh(mergedZh(zhLines));
    if (!zh || zh.length < 2) continue;
    const hitStr = matched.join(' ');
    let tag = 'molecular';
    if (/肿瘤|癌|致癌|恶性|转移|浸润|化疗|放疗|靶向|耐药|预后|活检|分期|分级|免疫|抗体|抗原|微环境|异质性/.test(hitStr)) tag = 'oncology';
    else if (/基因|基因组|遗传|染色体|染色质|组蛋白|甲基化|乙酰化|表观|多态性|等位基因|易位|拷贝数|外显子|内含子|剪接|启动子|增强子/.test(hitStr)) tag = 'genetics';
    else if (/测序|比对|注释|组装|转录组|蛋白组|代谢组|生物信息|富集|聚类|差异表达|变异位点/.test(hitStr)) tag = 'bioinfo';
    hits.push({ w: e.word.trim(), ph: normPhone(ph), pos: guessPos(joined), zh, freq, tags: ['pro', tag] });
  }
  log(`扫描 ${scanned}，命中专业词 ${hits.length}`);

  const seen = new Set();
  const proWords = [];
  hits.sort((a, b) => a.freq - b.freq);
  for (const h of hits) {
    const k = h.w.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    proWords.push(h);
    if (proWords.length >= limit) break;
  }
  log(`取词频前 ${proWords.length} 个专业词`);

  // BioWordlists 补充（不足 limit 时）
  let bwAdded = 0;
  for (const f of ['terms_genes.tsv', 'terms_cancers.tsv', 'terms_variants.tsv', 'terms_proteins.tsv']) {
    const fp = join(bwDir, f);
    if (!existsSync(fp) || proWords.length >= limit) continue;
    const tag = f.includes('cancers') ? 'oncology' : f.includes('proteins') ? 'molecular' : 'genetics';
    const rl2 = createInterface({ input: createReadStream(fp, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl2) {
      if (!line.trim() || proWords.length >= limit) continue;
      const cols = line.split('\t');
      for (const name of String(cols[1] || '').split('|').map((s) => s.trim()).filter(Boolean)) {
        if (proWords.length >= limit) break;
        const w = name.trim();
        if (!isCleanWord(w) || seen.has(w.toLowerCase())) continue;
        seen.add(w.toLowerCase());
        proWords.push({ w, ph: '', pos: '', zh: '', freq: 999998, tags: ['pro', tag], pendingZh: true });
        bwAdded++;
      }
    }
  }
  if (bwAdded) log(`BioWordlists 补充 ${bwAdded} 条（中文待补）`);

  const book = {
    version: 1,
    book: 'pro',
    label: '生物·生信',
    count: proWords.length,
    generatedAt: new Date().toISOString().slice(0, 10),
    source: 'ECDICT (MIT, StarDict) + BioWordlists (CC0)；中文释义来自 ECDICT，缺失项 pendingZh=true',
    words: proWords,
  };
  ensureOutDir();
  writeFileSync(join(OUT_DIR, 'pro.json'), JSON.stringify(book), 'utf8');
  const pending = proWords.filter((w) => w.pendingZh).length;
  log(`pro.json 写出 ${proWords.length} 词（${pending} 条中文待补）`);

  const step = Math.max(1, Math.floor(proWords.length / 200));
  const sample = proWords.filter((_, i) => i % step === 0).slice(0, 200);
  writeFileSync(
    join(OUT_DIR, 'pro.report.json'),
    JSON.stringify(
      {
        total: proWords.length,
        pendingZh: pending,
        byTag: proWords.reduce((acc, w) => {
          const t = w.tags[1] || 'other';
          acc[t] = (acc[t] || 0) + 1;
          return acc;
        }, {}),
        sample,
      },
      null,
      2
    ),
    'utf8'
  );
  log('校对报告 pro.report.json 已写出');
  return book;
}

function verify() {
  let ok = true;
  for (const book of ['cet6', 'pro']) {
    const fp = join(OUT_DIR, book + '.json');
    if (!existsSync(fp)) {
      console.log(`  ✗ ${book}.json 不存在`);
      ok = false;
      continue;
    }
    const j = JSON.parse(readFileSync(fp, 'utf8'));
    const words = j.words || [];
    const seen = new Set();
    let dup = 0;
    let bad = 0;
    for (const w of words) {
      if (!w.w || !w.zh) bad++;
      const k = String(w.w).toLowerCase();
      if (seen.has(k)) dup++;
      seen.add(k);
    }
    console.log(`  ${book}: ${words.length} 词，重复 ${dup}，字段不全 ${bad}，体积 ${(JSON.stringify(j).length / 1024).toFixed(0)}KB`);
    if (dup || bad) ok = false;
  }
  console.log(ok ? '  ✓ verify 通过' : '  ✗ verify 有问题');
  process.exit(ok ? 0 : 1);
}

function writeMeta(books) {
  const metaPath = join(OUT_DIR, 'meta.json');
  let meta = { version: 1, books: {} };
  if (existsSync(metaPath)) {
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    } catch {
      /* rebuild */
    }
  }
  for (const [key, book] of Object.entries(books)) {
    if (!book) continue;
    meta.books[key] = { label: book.label, file: key + '.json', count: book.count, source: book.source, generatedAt: book.generatedAt };
  }
  meta.updatedAt = new Date().toISOString().slice(0, 10);
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  log('meta.json 更新：', JSON.stringify(meta.books));
}

(async () => {
  ensureOutDir();
  if (has('--verify')) return verify();
  if (has('--cet6')) writeMeta({ cet6: buildCet6(argOf('--input')) });
  if (has('--pro')) writeMeta({ pro: await buildPro({ ecdict: argOf('--ecdict'), biowordlists: argOf('--biowordlists'), limit: argOf('--limit') }) });
  if (!has('--cet6') && !has('--pro') && !has('--verify')) console.log('用法：--cet6 | --pro [--limit N] | --verify');
})();
