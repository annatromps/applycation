// Shared docx styling helpers, used by both the CV and cover-letter
// generators so tailored documents look consistent. Colors/fonts/margins
// pulled forward from a previously hand-tuned, visually-verified template —
// change here to re-theme every generated document at once.

const {
  Paragraph, TextRun, HeadingLevel, AlignmentType,
  BorderStyle, LevelFormat, convertInchesToTwip,
} = require("docx");

const NAVY = "1F2A44";
const GREY = "555555";
const RULE = "CCCCCC";
const FONT = "Calibri";

const A4_PAGE = { width: 11907, height: 16840 };

function bullet(text) {
  return new Paragraph({
    numbering: { reference: "cv-bullets", level: 0 },
    spacing: { after: 60 },
    children: [new TextRun({ text, font: FONT, size: 21 })],
  });
}

function roleHeader(title, company, dates) {
  return new Paragraph({
    spacing: { before: 200, after: 20 },
    tabStops: [{ type: "right", position: convertInchesToTwip(6.5) }],
    children: [
      new TextRun({ text: `${title}, `, bold: true, font: FONT, size: 23, color: NAVY }),
      new TextRun({ text: company, bold: true, font: FONT, size: 23, color: NAVY }),
      new TextRun({ text: `\t${dates}`, font: FONT, size: 20, color: GREY }),
    ],
  });
}

function roleSub(text) {
  return new Paragraph({
    spacing: { after: 100 },
    children: [new TextRun({ text, italics: true, font: FONT, size: 20, color: GREY })],
  });
}

function sectionHeading(text) {
  return new Paragraph({
    spacing: { before: 320, after: 140 },
    border: { bottom: { color: RULE, space: 4, style: BorderStyle.SINGLE, size: 6 } },
    children: [new TextRun({ text: text.toUpperCase(), bold: true, font: FONT, size: 25, color: NAVY, characterSpacing: 12 })],
  });
}

function eduEntry(school, dates, detail) {
  return [
    new Paragraph({
      spacing: { before: 140, after: 10 },
      tabStops: [{ type: "right", position: convertInchesToTwip(6.5) }],
      children: [
        new TextRun({ text: school, bold: true, font: FONT, size: 21, color: NAVY }),
        new TextRun({ text: `\t${dates}`, font: FONT, size: 20, color: GREY }),
      ],
    }),
    new Paragraph({
      spacing: { after: 40 },
      children: [new TextRun({ text: detail, font: FONT, size: 20, color: GREY })],
    }),
  ];
}

function labeledLine(label, value) {
  return new Paragraph({
    spacing: { after: 60 },
    children: [
      new TextRun({ text: `${label}: `, bold: true, font: FONT, size: 21 }),
      new TextRun({ text: value, font: FONT, size: 21 }),
    ],
  });
}

const BULLET_NUMBERING = {
  config: [
    {
      reference: "cv-bullets",
      levels: [
        {
          level: 0,
          format: LevelFormat.BULLET,
          text: "•",
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 260, hanging: 180 } } },
        },
      ],
    },
  ],
};

module.exports = {
  NAVY, GREY, RULE, FONT, A4_PAGE, BULLET_NUMBERING,
  bullet, roleHeader, roleSub, sectionHeading, eduEntry, labeledLine,
};
