const express = require("express");
const multer = require("multer");
const router = express.Router();
const db = require("./../db");
const { extractText } = require("./../docgen/extractText");
const { importProfileFromText } = require("./../docgen/importProfile");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const MIME_FOR_EXT = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

// Determine the canonical extension from mimetype first, filename second.
// Browsers set an accurate mimetype from the file input; tools like curl
// often don't, so the filename fallback keeps direct API testing honest too.
function extFor(mimetype, originalname) {
  if (mimetype === MIME_FOR_EXT[".pdf"]) return ".pdf";
  if (mimetype === MIME_FOR_EXT[".docx"]) return ".docx";
  if (/\.docx$/i.test(originalname)) return ".docx";
  if (/\.pdf$/i.test(originalname)) return ".pdf";
  return null;
}

router.get("/", async (req, res) => {
  const { candidateProfile } = await db.read();
  res.json(candidateProfile);
});

router.put("/", async (req, res) => {
  const data = await db.read();
  data.candidateProfile = req.body;
  await db.write(data);
  res.json({ ok: true });
});

// ---------- Baseline CV file upload ----------
// Stored as base64 inside the same JSON blob as everything else (see
// db-postgres.js) rather than on local disk, so it survives redeploys on
// hosts with ephemeral filesystems.

router.get("/cv-upload", async (req, res) => {
  const { cvUpload } = await db.read();
  if (!cvUpload) return res.json(null);
  const { dataBase64, extractedText, ...meta } = cvUpload;
  res.json({ ...meta, textLength: (extractedText || "").length });
});

router.post("/cv-upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  const ext = extFor(req.file.mimetype, req.file.originalname);
  if (!ext) {
    return res.status(400).json({ error: "Unsupported file type — please upload a PDF or .docx file." });
  }
  const mimetype = MIME_FOR_EXT[ext];

  let text;
  try {
    ({ text } = await extractText(req.file.buffer, mimetype, req.file.originalname));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const data = await db.read();
  data.cvUpload = {
    originalFilename: req.file.originalname,
    mimetype,
    dataBase64: req.file.buffer.toString("base64"),
    extractedText: text,
    uploadedAt: new Date().toISOString(),
  };
  if (!data.candidateProfile) {
    data.candidateProfile = { name: "", email: "", phone: "", linkedin: "", headline: "", summary: "", skills: [], experience: [], education: [], additional: [], talkingPoints: [], houseRules: { bannedPhrases: [], notes: "" } };
  }
  await db.write(data);

  const { dataBase64, extractedText, ...meta } = data.cvUpload;
  res.status(201).json({ ...meta, textLength: text.length });
});

router.delete("/cv-upload", async (req, res) => {
  const data = await db.read();
  data.cvUpload = null;
  await db.write(data);
  res.json({ ok: true });
});

function serveCvFile(cvUpload, res, disposition) {
  if (!cvUpload) return res.status(404).json({ error: "No CV uploaded yet." });
  res.setHeader("Content-Type", cvUpload.mimetype);
  res.setHeader("Content-Disposition", `${disposition}; filename="${cvUpload.originalFilename.replace(/"/g, "")}"`);
  res.send(Buffer.from(cvUpload.dataBase64, "base64"));
}

router.get("/cv-upload/view", async (req, res) => {
  const { cvUpload } = await db.read();
  serveCvFile(cvUpload, res, "inline");
});
router.get("/cv-upload/download", async (req, res) => {
  const { cvUpload } = await db.read();
  serveCvFile(cvUpload, res, "attachment");
});

// ---------- AI-assisted import into the structured profile ----------

router.post("/import-from-cv", async (req, res) => {
  const data = await db.read();
  if (!data.cvUpload) return res.status(400).json({ error: "Upload a CV file first." });
  try {
    const draft = await importProfileFromText({
      text: data.cvUpload.extractedText,
      existingProfile: data.candidateProfile,
      settings: data.settings,
    });
    res.json(draft); // draft only — nothing is saved until the user hits Save
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
