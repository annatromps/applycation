// Extracts plain text from an uploaded baseline CV file (PDF or DOCX), so it
// can be used as grounding for AI-assisted profile import and cover-letter
// drafting. Deliberately supports only PDF and DOCX — legacy .doc has no
// good pure-JS text extractor and isn't worth the extra dependency weight.

const mammoth = require("mammoth");

const SUPPORTED = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

function kindFor(mimetype, originalFilename) {
  if (SUPPORTED[mimetype]) return SUPPORTED[mimetype];
  // Some browsers send generic mimetypes for uploads; fall back to extension.
  if (/\.pdf$/i.test(originalFilename)) return "pdf";
  if (/\.docx$/i.test(originalFilename)) return "docx";
  return null;
}

async function extractText(buffer, mimetype, originalFilename) {
  const kind = kindFor(mimetype, originalFilename);
  if (!kind) {
    throw new Error("Unsupported file type — please upload a PDF or .docx file (legacy .doc isn't supported).");
  }
  if (kind === "pdf") {
    // Lazy-require: pdf-parse does some work at module load time we don't
    // need to pay for unless a PDF is actually uploaded.
    // Note: pdf-parse v2's API is class-based (new PDFParse({ data }).getText()),
    // a breaking change from the old v1 pdf(buffer) function-call API.
    const { PDFParse } = require("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return { kind, text: (result.text || "").trim() };
    } finally {
      await parser.destroy();
    }
  }
  const result = await mammoth.extractRawText({ buffer });
  return { kind, text: (result.value || "").trim() };
}

module.exports = { extractText, kindFor };
