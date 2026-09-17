// Browser-side PDF reading. Pulls the text layer, and falls back to page
// images (for scanned syllabi) so the AI can read them visually.
// Everything is imported lazily so pdf.js never runs during SSR.

export type SyllabusExtraction = {
  text: string;
  pageImages: string[];
  scanned: boolean;
  pages: number;
};

async function loadPdfjs() {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

export async function extractSyllabus(
  file: File,
  onProgress?: (message: string) => void,
): Promise<SyllabusExtraction> {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data }).promise;
  const pages = pdf.numPages;
  let text = "";

  for (let i = 1; i <= pages; i++) {
    onProgress?.(`Reading page ${i} of ${pages}`);
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    text += `\n\n--- Page ${i} ---\n${pageText}`;
  }

  const scanned = text.replace(/\s/g, "").length < 200;
  const pageImages: string[] = [];

  if (scanned) {
    const limit = Math.min(pages, 6);
    for (let i = 1; i <= limit; i++) {
      onProgress?.(`Scanning page ${i} of ${limit}`);
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1.6 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const context = canvas.getContext("2d");
      if (!context) continue;
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      pageImages.push(canvas.toDataURL("image/jpeg", 0.7));
    }
  }

  return { text: text.slice(0, 120000), pageImages, scanned, pages };
}
