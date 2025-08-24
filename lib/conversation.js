// lib/conversation.js
// Domain-agnostic conversation layer for RAG + optional LLM fallback (vanilla Node.js)

const FOLLOWUP_RE = /^(what about|how about|and\b|also\b|and\s+what|what\s+else|ok,\s*but)/i;

const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","so","of","in","on","for","to","from","with",
  "about","regarding","is","are","was","were","be","been","it","that","this","those",
  "these","at","by","as","into","over","under","after","before","then","than","just",
  "can","could","should","would","do","does","did","have","has","had","you","your"
]);

function tokenize(text){
  return String(text||"")
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_/]/gi, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function extractSalientTerms(text, max=12){
  const counts = Object.create(null);
  const capitalized = (String(text||"").match(/\b[A-Z][a-z0-9\-_/]+(?:\s+[A-Z][a-z0-9\-_/]+)*\b/g) || []).map(s=>s.trim());

  for(const tok of tokenize(text)){
    if (STOPWORDS.has(tok) || tok.length < 3) continue;
    counts[tok] = (counts[tok]||0) + 1;
  }
  const freq = Object.entries(counts)
    .sort((a,b)=>b[1]-a[1])
    .slice(0, max)
    .map(([t])=>t);

  const merged = [...capitalized, ...freq];
  const seen = new Set();
  const out = [];
  for(const term of merged){
    const key = term.toLowerCase();
    if(!seen.has(key)){ seen.add(key); out.push(term); }
    if(out.length >= max) break;
  }
  return out;
}

function inferObjective(text){
  const m =
    String(text||"").match(/\b(summarize|compare|explain|list|find|give|show|calculate|convert|estimate|translate)\b.*$/i) ||
    String(text||"").match(/\b(how|why|what|which|when)\b.*$/i);
  return m ? m[0].trim() : undefined;
}

function summarizeRecentHistory(history, limit=4){
  const recent = history.slice(-limit);
  return recent.map(m => (m.role === "user" ? `User: ${m.content}` : `Assistant: ${m.content}`)).join("\n");
}

function initState(){
  return { messages: [], contextTerms: [], lastObjective: undefined };
}

function updateState(state, userText){
  const contextTerms = new Set(state.contextTerms || []);
  for(const t of extractSalientTerms(userText)) contextTerms.add(t);
  const objective = inferObjective(userText) || state.lastObjective;

  state.contextTerms = Array.from(contextTerms).slice(0, 16);
  state.lastObjective = objective;
  state.messages.push({ role: "user", content: userText });
}

/**
 * Deterministic follow-up rewrite:
 * - If message is short or starts with "what about"/"how about"/etc,
 *   return: "<original> (context: term1 term2 term3 ...)"
 * - Otherwise return the message unchanged.
 */
function rewriteQuery(userText, state){
  const isFollowUp = FOLLOWUP_RE.test(userText) || userText.trim().split(/\s+/).length < 6;
  if(!isFollowUp) return userText;

  // pull a few stable context terms
  const terms = (state.contextTerms || []).slice(0, 8).join(" ");
  // include last objective keywords if we have them
  const obj = state.lastObjective ? ` ${state.lastObjective}` : "";

  // Compact, search-friendly query that still carries context
  // Example: "what about sydney (context: seattle weather average rain)"
  return `${userText}${terms ? ` (context:${obj} ${terms})` : ""}`.trim();
}

function selectUsable(results, threshold=0.38){
  return (results||[]).filter(r => (r.score ?? 0) >= threshold);
}

function formatAnswer(doc){
  const src = (doc.meta && (doc.meta.title || doc.meta.source || doc.meta.url)) || "document";
  return `${String(doc.text||'').trim()}\n\n— from ${src}`;
}

/**
 * answerTurn(state, userText, retriever, llm?, opts?)
 * retriever.search(query, { topK, mmr }) => [{ text, score, meta }, ...]
 * llm.generate(prompt) => string (optional)
 */
async function answerTurn(state, userText, retriever, llm, opts){
  opts = opts || {};
  updateState(state, userText);

  // 1) Build a concrete query for retrieval (no LLM needed to rewrite)
  const rewritten = rewriteQuery(userText, state);

  // 2) Retrieve
  const topK = opts.topK ?? 5;
  const results = await retriever.search(rewritten, { topK, mmr: true });

  // 3) Filter
  const usable = selectUsable(results, opts.threshold ?? 0.38);

  // 4) Answer: RAG if possible, else LLM fallback with conversation hint
  let answer;
  let mode;
  if(usable.length){
    answer = formatAnswer(usable[0]);
    mode = "rag";
  } else if (llm && typeof llm.generate === "function"){
    const hint = summarizeRecentHistory(state.messages, 6);
    answer = await llm.generate(
      `Using the conversation below, answer the latest user message as best you can, concisely.\n\n${hint}\n\nUser: ${userText}\nAssistant:`
    );
    mode = "llm_fallback";
  } else {
    answer = "I don’t have that in the documents yet.";
    mode = "unknown";
  }

  // optional: paraphrase final style (kept off by default)
  if (opts.paraphrase && llm && typeof llm.generate === "function"){
    answer = await llm.generate(`Rewrite the following answer to be clear, concise, and friendly, preserving facts:\n\n${answer}`);
  }

  state.messages.push({ role: "assistant", content: answer });
  return { text: answer, hits: usable, mode };
}

module.exports = {
  initState,
  updateState,
  rewriteQuery,
  selectUsable,
  answerTurn
};