import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useRef, useState } from "react";
import {
  BookOpen,
  ExternalLink,
  FileUp,
  Library,
  Loader2,
  MapPin,
  ScanLine,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { extractSyllabus } from "@/lib/pdf";
import {
  lookupCatalog,
  parseSyllabus,
  type LinkedReading,
} from "@/lib/syllabus.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Shelfmark — Syllabus to Library Catalog Linker" },
      {
        name: "description",
        content:
          "Upload a course syllabus PDF and get every required reading matched to library e-books, journal full text and shelf locations.",
      },
      { property: "og:title", content: "Shelfmark — Syllabus to Library Catalog Linker" },
      {
        property: "og:description",
        content:
          "Turn a syllabus PDF into a reading list with availability, call numbers and direct full-text links.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Home,
});

type Stage = "idle" | "reading" | "parsing" | "matching" | "done" | "error";

const statusStyles: Record<LinkedReading["catalog"]["status"], string> = {
  digital: "bg-primary/10 text-primary border-primary/20",
  shelf: "bg-shelf/10 text-shelf border-shelf/20",
  unavailable: "bg-muted text-muted-foreground border-border",
};

function Home() {
  const parse = useServerFn(parseSyllabus);
  const lookup = useServerFn(lookupCatalog);
  const inputRef = useRef<HTMLInputElement>(null);

  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [course, setCourse] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [scanned, setScanned] = useState(false);
  const [readings, setReadings] = useState<LinkedReading[]>([]);
  const [filter, setFilter] = useState("");

  const busy = stage === "reading" || stage === "parsing" || stage === "matching";

  async function handleFile(file: File) {
    setError(null);
    setReadings([]);
    setCourse(null);
    setFileName(file.name);
    try {
      setStage("reading");
      const extracted = await extractSyllabus(file, setProgress);
      setScanned(extracted.scanned);

      setStage("parsing");
      setProgress(
        extracted.scanned
          ? "Reading the scanned pages"
          : "Finding assigned readings",
      );
      const parsed = await parse({
        data: {
          text: extracted.text,
          pageImages: extracted.pageImages,
          courseHint: null,
        },
      });
      setCourse(parsed.course);

      if (!parsed.readings.length) {
        setStage("done");
        setReadings([]);
        return;
      }

      setStage("matching");
      setProgress(`Checking the library for ${parsed.readings.length} readings`);
      const linked = await lookup({ data: { readings: parsed.readings } });
      setReadings(linked);
      setStage("done");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Something went wrong with that file.",
      );
      setStage("error");
    }
  }

  const visible = readings.filter((r) =>
    `${r.title} ${r.authors ?? ""} ${r.source ?? ""}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  const counts = {
    digital: readings.filter((r) => r.catalog.status === "digital").length,
    shelf: readings.filter((r) => r.catalog.status === "shelf").length,
    missing: readings.filter((r) => r.catalog.status === "unavailable").length,
  };

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl px-5 py-12 md:py-20">
      <header className="flex items-center gap-3 text-primary">
        <Library className="size-5" />
        <span className="text-sm font-medium tracking-[0.2em] uppercase">Shelfmark</span>
      </header>

      <h1 className="mt-8 text-4xl leading-tight md:text-6xl">
        Turn your syllabus into a
        <em className="text-accent"> borrowable </em>
        reading list.
      </h1>
      <p className="mt-4 max-w-xl text-muted-foreground">
        Upload the course PDF. Every assigned book, chapter and article is pulled out
        and matched against the catalog, with full-text links or a shelf location.
      </p>

      <section className="mt-10">
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files?.[0];
            if (file && !busy) handleFile(file);
          }}
          className="paper-card flex flex-col items-center gap-4 px-6 py-12 text-center"
        >
          <div className="rounded-full bg-secondary p-4 text-primary">
            {busy ? (
              <Loader2 className="size-6 animate-spin" />
            ) : (
              <FileUp className="size-6" />
            )}
          </div>
          <div>
            <p className="text-lg">
              {busy ? progress || "Working…" : "Drop your syllabus PDF here"}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {fileName && !busy ? fileName : "Scanned copies are read visually too"}
            </p>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
              e.target.value = "";
            }}
          />
          <Button disabled={busy} onClick={() => inputRef.current?.click()}>
            Choose a PDF
          </Button>
        </div>

        {error && (
          <p className="mt-4 text-sm text-destructive">{error}</p>
        )}
      </section>

      {stage === "done" && (
        <section className="mt-14">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-2xl">{course ?? "Your reading list"}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {readings.length} readings found
                {scanned && (
                  <span className="ml-2 inline-flex items-center gap-1">
                    <ScanLine className="size-3.5" /> read from a scan
                  </span>
                )}
              </p>
            </div>
            {readings.length > 0 && (
              <div className="flex items-center gap-2">
                <Search className="size-4 text-muted-foreground" />
                <Input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter readings"
                  className="h-9 w-48"
                />
              </div>
            )}
          </div>

          {readings.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2 text-sm">
              <Badge variant="outline" className={statusStyles.digital}>
                {counts.digital} online
              </Badge>
              <Badge variant="outline" className={statusStyles.shelf}>
                {counts.shelf} on the shelf
              </Badge>
              <Badge variant="outline" className={statusStyles.unavailable}>
                {counts.missing} need a request
              </Badge>
            </div>
          )}

          <ul className="mt-6 space-y-3">
            {visible.map((reading) => (
              <li key={reading.id} className="paper-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant="outline"
                        className={statusStyles[reading.catalog.status]}
                      >
                        {reading.catalog.label}
                      </Badge>
                      {!reading.required && (
                        <Badge variant="outline" className="text-muted-foreground">
                          optional
                        </Badge>
                      )}
                      {reading.week && (
                        <span className="text-xs tracking-wide text-muted-foreground uppercase">
                          {reading.week}
                        </span>
                      )}
                    </div>
                    <h3 className="mt-2 text-xl leading-snug">{reading.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {[reading.authors, reading.source, reading.year]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                      <span className="inline-flex items-center gap-1.5 text-foreground">
                        <BookOpen className="size-3.5 text-muted-foreground" />
                        {reading.catalog.detail}
                      </span>
                      {reading.catalog.callNumber && (
                        <span className="inline-flex items-center gap-1.5 font-mono text-xs text-shelf">
                          <MapPin className="size-3.5" />
                          {reading.catalog.callNumber}
                        </span>
                      )}
                    </p>
                  </div>
                  {reading.catalog.url && (
                    <Button asChild variant="secondary" size="sm">
                      <a
                        href={reading.catalog.url}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {reading.catalog.linkLabel}
                        <ExternalLink className="size-3.5" />
                      </a>
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>

          {readings.length === 0 && (
            <p className="paper-card mt-6 p-6 text-sm text-muted-foreground">
              No assigned readings were found in that document. Try a syllabus that
              lists its readings, or a clearer scan.
            </p>
          )}
        </section>
      )}

      <footer className="mt-20 text-xs text-muted-foreground">
        Matches come from Crossref and Open Library. Shelf locations are indicative —
        confirm at your library's desk.
      </footer>
    </main>
  );
}
