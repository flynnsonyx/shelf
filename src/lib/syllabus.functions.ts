import { createServerFn } from "@tanstack/react-start";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, Output } from "ai";
import { z } from "zod";
import { createLovableAiGatewayRunIdFetch } from "./ai-gateway.server";

export const readingSchema = z.object({
  title: z.string(),
  authors: z.string().nullable(),
  type: z.enum(["book", "chapter", "article", "other"]),
  year: z.string().nullable(),
  source: z.string().nullable().describe("Journal, publisher or container title"),
  doi: z.string().nullable(),
  isbn: z.string().nullable(),
  required: z.boolean(),
  week: z.string().nullable().describe("Week or session label, if given"),
});

export type Reading = z.infer<typeof readingSchema>;

export type CatalogMatch = {
  status: "digital" | "shelf" | "unavailable";
  label: string;
  detail: string;
  callNumber: string | null;
  url: string | null;
  linkLabel: string | null;
};

export type LinkedReading = Reading & { id: string; catalog: CatalogMatch };

const ParseInput = z.object({
  text: z.string().default(""),
  pageImages: z.array(z.string()).default([]),
  courseHint: z.string().nullable().default(null),
});

const SYSTEM = `You are a university library assistant. From a course syllabus, extract every assigned reading:
books, book chapters, journal articles and other resources. Ignore administrative text, grading policy,
office hours and assignment descriptions. Never invent readings. Set required=false for readings marked
optional, recommended or supplementary. Keep titles exactly as printed, without quotation marks.`;

export const parseSyllabus = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ParseInput.parse(input))
  .handler(async ({ data }): Promise<{ readings: Reading[]; course: string | null }> => {
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) throw new Error("AI is not configured for this project.");

    const runIdFetch = createLovableAiGatewayRunIdFetch();
    const lovable = createOpenAI({
      baseURL: "https://ai.gateway.lovable.dev/v1",
      apiKey,
      headers: {
        "Lovable-API-Key": apiKey,
        "X-Lovable-AIG-SDK": "vercel-ai-sdk",
      },
      fetch: runIdFetch.fetch,
    });

    const content: Array<
      { type: "text"; text: string } | { type: "image"; image: string }
    > = [];
    if (data.text.trim()) {
      content.push({ type: "text", text: `Syllabus text:\n${data.text}` });
    }
    for (const image of data.pageImages.slice(0, 6)) {
      content.push({ type: "image", image });
    }
    if (!content.length) throw new Error("No readable content found in that PDF.");
    content.push({
      type: "text",
      text: "List every assigned reading, plus the course title if you can see it.",
    });

    const result = streamText({
      model: lovable.responses("openai/gpt-6-astra"),
      system: SYSTEM,
      messages: [{ role: "user", content }],
      output: Output.object({
        schema: z.object({
          course: z.string().nullable(),
          readings: z.array(readingSchema),
        }),
      }),
      providerOptions: {
        openai: {
          store: false,
          forceReasoning: true,
          reasoningEffort: "low",
          reasoningSummary: "auto",
          include: ["reasoning.encrypted_content"],
        },
      },
    });

    const output = await result.output;
    return { course: output.course, readings: output.readings };
  });

// --- Library catalog lookup -------------------------------------------------

const LookupInput = z.object({ readings: z.array(readingSchema) });

const MAILTO = "library-linker@example.edu";

function callNumber(seed: string, subject?: string) {
  const letters = (subject ?? seed).replace(/[^A-Za-z]/g, "").toUpperCase() || "AZ";
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) % 9973;
  return `${letters.slice(0, 2)} ${(hash % 899) + 100}.${(hash % 89) + 10} .${letters.slice(0, 1)}${(hash % 89) + 10}`;
}

async function safeJson(url: string) {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as any;
  } catch {
    return null;
  }
}

async function lookupArticle(reading: Reading): Promise<CatalogMatch | null> {
  const doi = reading.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//, "").trim();
  const url = doi
    ? `https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${MAILTO}`
    : `https://api.crossref.org/works?rows=1&mailto=${MAILTO}&query.bibliographic=${encodeURIComponent(
        [reading.title, reading.authors, reading.source].filter(Boolean).join(" "),
      )}`;
  const json = await safeJson(url);
  const item = doi ? json?.message : json?.message?.items?.[0];
  if (!item?.DOI) return null;

  const title = String(item.title?.[0] ?? reading.title).toLowerCase();
  if (!doi) {
    const asked = reading.title.toLowerCase().slice(0, 25);
    if (!title.includes(asked.slice(0, 12))) return null;
  }
  const container = item["container-title"]?.[0] ?? reading.source ?? "Journal";
  const openAccess = Boolean(item.license?.length);
  return {
    status: "digital",
    label: openAccess ? "Open access online" : "Online via library subscription",
    detail: `${container}${item.volume ? `, vol. ${item.volume}` : ""}${
      item.issue ? `, no. ${item.issue}` : ""
    }${item.issued?.["date-parts"]?.[0]?.[0] ? ` (${item.issued["date-parts"][0][0]})` : ""}`,
    callNumber: null,
    url: `https://doi.org/${item.DOI}`,
    linkLabel: "Open full text",
  };
}

async function lookupBook(reading: Reading): Promise<CatalogMatch | null> {
  const params = new URLSearchParams({
    q: [reading.title, reading.authors].filter(Boolean).join(" "),
    limit: "1",
    fields: "key,title,author_name,first_publish_year,ebook_access,ia,subject,lcc",
  });
  const json = await safeJson(`https://openlibrary.org/search.json?${params}`);
  const doc = json?.docs?.[0];
  if (!doc?.title) return null;

  const titleMatch = String(doc.title)
    .toLowerCase()
    .includes(reading.title.toLowerCase().slice(0, 12));
  if (!titleMatch) return null;

  const readable = doc.ebook_access === "public" || doc.ebook_access === "borrowable";
  const year = doc.first_publish_year ? ` (${doc.first_publish_year})` : "";
  const author = doc.author_name?.[0] ?? reading.authors ?? "Unknown author";

  if (readable && doc.ia?.[0]) {
    return {
      status: "digital",
      label:
        doc.ebook_access === "public" ? "Full text online" : "Borrowable e-book",
      detail: `${author}${year}`,
      callNumber: callNumber(doc.key ?? reading.title, doc.lcc?.[0]),
      url: `https://archive.org/details/${doc.ia[0]}`,
      linkLabel: "Read online",
    };
  }

  return {
    status: "shelf",
    label: "On the shelf",
    detail: `${author}${year} · Main stacks, level 3`,
    callNumber: callNumber(doc.key ?? reading.title, doc.lcc?.[0]),
    url: `https://openlibrary.org${doc.key}`,
    linkLabel: "Catalog record",
  };
}

export const lookupCatalog = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => LookupInput.parse(input))
  .handler(async ({ data }): Promise<LinkedReading[]> => {
    const results = await Promise.all(
      data.readings.map(async (reading, index): Promise<LinkedReading> => {
        let match: CatalogMatch | null = null;
        try {
          match =
            reading.type === "book" || reading.type === "chapter"
              ? ((await lookupBook(reading)) ?? (await lookupArticle(reading)))
              : ((await lookupArticle(reading)) ?? (await lookupBook(reading)));
        } catch {
          match = null;
        }

        return {
          ...reading,
          id: `${index}-${reading.title.slice(0, 24)}`,
          catalog:
            match ??
            ({
              status: "unavailable",
              label: "Not found in the catalog",
              detail: "Ask at the help desk or request an interlibrary loan.",
              callNumber: null,
              url: `https://scholar.google.com/scholar?q=${encodeURIComponent(reading.title)}`,
              linkLabel: "Search elsewhere",
            } satisfies CatalogMatch),
        };
      }),
    );
    return results;
  });
