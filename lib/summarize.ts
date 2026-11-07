import OpenAI from "openai";
import type { SectionKey } from "./edgar";

// Per-section character caps keep a 10-K well inside the context window and cost bounded.
const CAPS: Record<SectionKey, number> = { "Item 1": 60_000, "Item 1A": 60_000, "Item 7": 80_000 };

export type Bullet = { text: string; source: SectionKey; evidence: string; verified: boolean };
export type Brief = {
  oneLiner: string;
  businessSnapshot: Bullet[];
  keyFinancials: Bullet[];
  topRisks: Bullet[];
  mdnaHighlights: Bullet[];
  whatToWatch: Bullet[];
};

const bullet = {
  type: "object",
  additionalProperties: false,
  required: ["text", "source", "evidence"],
  properties: {
    text: { type: "string", description: "One concise, factual sentence for an advisor." },
    source: { type: "string", enum: ["Item 1", "Item 1A", "Item 7"] },
    evidence: {
      type: "string",
      description:
        "ONE contiguous VERBATIM excerpt (8-30 words) copied character-for-character from the cited section. No ellipses, no stitching, no paraphrase.",
    },
  },
};
const list = (n: string) => ({ type: "array", items: bullet, description: n });

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["oneLiner", "businessSnapshot", "keyFinancials", "topRisks", "mdnaHighlights", "whatToWatch"],
  properties: {
    oneLiner: { type: "string", description: "One sentence: what the company does and how it makes money." },
    businessSnapshot: list("3-5 bullets: segments, products, customers, competitive position."),
    keyFinancials: list("3-5 bullets with specific figures (revenue, margins, growth, cash) as stated in MD&A."),
    topRisks: list("The 5 most material, company-specific risks (skip boilerplate)."),
    mdnaHighlights: list("3-5 bullets: what management says drove results and their outlook."),
    whatToWatch: list("2-4 forward-looking items an advisor should monitor, grounded in the filing."),
  },
};

const SYSTEM = `You are a research assistant helping wealth-management advisors get up to speed on a public company from its latest Form 10-K.
Rules:
- Use ONLY the provided filing text. Never use outside knowledge, never invent figures.
- Every bullet must cite the Item it came from and include ONE contiguous, verbatim evidence excerpt from that Item. Never join fragments with "..." and never paraphrase the evidence.
- Be neutral and factual. Do not give investment advice, ratings, or price targets.
- If a section is missing, return fewer bullets rather than guessing.`;

// Normalize for matching: case, quotes/apostrophes, list bullets, and whitespace differ between HTML and model output.
const norm = (s: string) =>
  s.toLowerCase().replace(/[“”"'’‘]/g, "").replace(/[•●▪◦]/g, " ").replace(/\s+/g, " ").trim();

export async function summarize10K(
  company: string,
  fiscalPeriod: string,
  sections: Record<SectionKey, string | null>,
): Promise<Brief> {
  const client = new OpenAI();
  const body = (Object.keys(CAPS) as SectionKey[])
    .map((k) => `===== ${k} =====\n${sections[k] ? sections[k]!.slice(0, CAPS[k]) : "(section not found)"}`)
    .join("\n\n");

  const res = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `Company: ${company}\nFiscal period ending: ${fiscalPeriod}\n\n${body}` },
    ],
    response_format: { type: "json_schema", json_schema: { name: "brief", strict: true, schema: SCHEMA } },
  });

  const raw = JSON.parse(res.choices[0].message.content ?? "{}");

  // Grounding check: confirm each evidence excerpt actually appears in the cited section.
  const normSections = Object.fromEntries(
    Object.entries(sections).map(([k, v]) => [k, v ? norm(v) : ""]),
  ) as Record<SectionKey, string>;
  // Models sometimes elide with "..." despite instructions; accept that only if every fragment
  // appears in the cited section, in order.
  const found = (section: string, evidence: string) => {
    // Trim edge punctuation: models end a truncated sentence with "." where the source continues.
    const parts = evidence
      .split(/\.{3}|…/)
      .map((p) => norm(p).replace(/^[\s.,;:]+|[\s.,;:]+$/g, ""))
      .filter((p) => p.length > 0);
    if (parts.length === 0) return false;
    let pos = 0;
    for (const p of parts) {
      const i = section.indexOf(p, pos);
      if (i < 0) return false;
      pos = i + p.length;
    }
    return true;
  };
  const verify = (list: Omit<Bullet, "verified">[]): Bullet[] =>
    list.map((b) => ({ ...b, verified: found(normSections[b.source], b.evidence) }));

  return {
    oneLiner: raw.oneLiner,
    businessSnapshot: verify(raw.businessSnapshot),
    keyFinancials: verify(raw.keyFinancials),
    topRisks: verify(raw.topRisks),
    mdnaHighlights: verify(raw.mdnaHighlights),
    whatToWatch: verify(raw.whatToWatch),
  };
}
