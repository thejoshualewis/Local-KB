// lib/chunking.js
// Text parsing/normalization + block/QA detection + chunk packing.
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

/** normalize: collapse whitespace so retrieval is less brittle */
function normalize(s){ return (s || '').replace(/\s+/g, ' ').trim(); }

/** parseBlocks: detect QA blocks (Q:/A:) or paragraphs split by blank lines */
function parseBlocks(raw){
  const lines = (raw || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  const blank = s => !s || /^\s*$/.test(s);
  const qline = s => /^(q(uestion)?\s*[:\-]?)\s*/i.test(s || '');
  const endsQ = s => /\?\s*$/.test((s || '').trim());

  while (i < lines.length) {
    let line = (lines[i] || '').trim();
    if (blank(line)) { i++; continue; }

    // Case A: "Q:" prefixed
    if (qline(line)) {
      const q = line.replace(/^(q(uestion)?\s*[:\-]?)\s*/i, '').trim();
      i++;
      const a = [];
      while (i < lines.length) {
        const ln = (lines[i] || '').trim();
        if (blank(ln) || qline(ln)) break;
        a.push(/^a\s*[:\-]?\s*/i.test(ln) ? ln.replace(/^a\s*[:\-]?\s*/i, '').trim() : ln);
        i++;
      }
      blocks.push(normalize(`Q: ${q}\nA: ${a.join(' ')}`));
      continue;
    }

    // Case B: "question?\nanswer ..."
    if (endsQ(line)) {
      const q = line;
      const a = [];
      let j = i + 1;
      while (j < lines.length) {
        const ln = (lines[j] || '').trim();
        if (blank(ln) || qline(ln) || endsQ(ln)) break;
        a.push(ln);
        j++;
      }
      if (a.length) {
        blocks.push(normalize(`Q: ${q}\nA: ${a.join(' ')}`));
        i = j;
        continue;
      }
    }

    // Case C: paragraph until blank/Q
    const paras = [line];
    i++;
    while (i < lines.length) {
      const ln = (lines[i] || '').trim();
      if (blank(ln) || qline(ln)) break;
      paras.push(ln);
      i++;
    }
    blocks.push(normalize(paras.join(' ')));
  }
  return blocks.filter(Boolean);
}

/** packBlocks: aggregate blocks into ~CHUNK_SIZE text chunks with overlap */
function packBlocks(blocks, size, overlap){
  const chunks = [];
  let cur = '';
  const push = () => { if (cur.trim()) { chunks.push(cur.trim()); cur=''; } };

  for (const b of blocks) {
    if (b.length > size) {
      // sentence-aware split
      const sents = b.split(/(?<=[.!?])\s+(?=[A-Z0-9‘“"(\[])/).map(s => s.trim()).filter(Boolean);
      let buf = '';
      for (const s of sents) {
        if ((buf ? buf.length + 1 : 0) + s.length <= size) {
          buf += (buf ? ' ' : '') + s;
        } else {
          if (buf) chunks.push(buf);
          if (s.length > size) {
            for (let i = 0; i < s.length; i += size) chunks.push(s.slice(i, i + size));
            buf = '';
          } else {
            buf = s;
          }
        }
      }
      if (buf) chunks.push(buf);
      continue;
    }
    if ((cur ? cur.length + 2 : 0) + b.length <= size) cur += (cur ? '\n\n' : '') + b;
    else { push(); cur = b; }
  }
  push();

  // Add simple overlap if requested
  if (overlap > 0 && chunks.length > 1) {
    const o = Math.min(overlap, size >> 1);
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i-1];
      const tail = prev.slice(Math.max(0, prev.length - o));
      chunks[i] = tail + '\n\n' + chunks[i];
    }
  }

  return chunks;
}

/** readDoc: read txt/md/pdf into plain text */
async function readDoc(p){
  const ext = path.extname(p).toLowerCase();
  if (ext === '.txt' || ext === '.md') return fs.readFileSync(p, 'utf8');
  if (ext === '.pdf') {
    const buf = fs.readFileSync(p);
    const pdf = await pdfParse(buf);
    return pdf.text || '';
  }
  return '';
}

module.exports = { normalize, parseBlocks, packBlocks, readDoc };
