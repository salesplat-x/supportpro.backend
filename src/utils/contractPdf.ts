import PDFDocument from "pdfkit";

export interface ContractSignature {
  name: string;
  email: string;
  signedAt: Date;
  sentBy: string | null;
  sentAt: Date | null;
  openedAt: Date | null;
  checkCode: string;
  check: { documentId: string; verifyUrl: string } | null;
}

export interface ContractPdfInput {
  companyName: string;
  logo: Buffer | null;
  title: string;
  dateLabel: string;
  body: string;
  signatory: string | null;
  employeeName: string;
  signature: ContractSignature | null;
}

const PAGE_MARGIN = 64;
const INK = "#101828";
const BODY = "#1a1f24";
const MUTED = "#5c6b7a";
const ACCENT = "#1f4b7a";

const isPngOrJpeg = (image: Buffer): boolean =>
  (image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47) ||
  (image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff);

const lagosStamp = (date: Date): string =>
  `${date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Africa/Lagos",
  })}, ${date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Africa/Lagos",
  })} (Lagos time)`;

const shortDate = (date: Date): string =>
  date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Africa/Lagos",
  });

export async function generateContractPdf(input: ContractPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: PAGE_MARGIN,
      info: {
        Title: input.title,
        Author: input.companyName,
        ...(input.signature ? { CreationDate: input.signature.signedAt } : {}),
      },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const width = doc.page.width - PAGE_MARGIN * 2;

    if (input.logo && isPngOrJpeg(input.logo)) {
      doc.image(input.logo, { fit: [160, 48] });
    } else {
      doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(14).text(input.companyName, { width });
    }
    doc.moveDown(2);

    doc.fillColor(INK).font("Helvetica-Bold").fontSize(18).text(input.title, { width });
    doc.moveDown(0.3);
    doc.fillColor(MUTED).font("Helvetica").fontSize(10).text(input.dateLabel, { width });
    doc.moveDown(1.5);

    doc.fillColor(BODY).font("Helvetica").fontSize(11);
    for (const paragraph of input.body.split("\n\n")) {
      doc.text(paragraph, { width, lineGap: 3 });
      doc.moveDown(0.8);
    }

    const columnWidth = (width - 32) / 2;
    const bottom = doc.page.height - PAGE_MARGIN;
    let y = Math.max(doc.y + 48, bottom - 120);
    if (y + 50 > bottom) {
      doc.addPage();
      y = PAGE_MARGIN + 24;
    }
    const columns: Array<{ x: number; heading: string; line: string }> = [
      {
        x: PAGE_MARGIN,
        heading: `For ${input.companyName}`,
        line: input.signatory ?? "",
      },
      {
        x: PAGE_MARGIN + columnWidth + 32,
        heading: "Accepted by",
        line: input.signature
          ? `${input.signature.name} · ${shortDate(input.signature.signedAt)}`
          : `${input.employeeName} · Date`,
      },
    ];
    for (const column of columns) {
      doc
        .moveTo(column.x, y)
        .lineTo(column.x + columnWidth, y)
        .strokeColor("#d0d5dd")
        .lineWidth(0.8)
        .stroke();
      doc
        .fillColor(INK)
        .font("Helvetica-Bold")
        .fontSize(10)
        .text(column.heading, column.x, y + 8, { width: columnWidth });
      doc
        .fillColor(MUTED)
        .font("Helvetica")
        .fontSize(10)
        .text(column.line, column.x, y + 24, { width: columnWidth });
    }

    if (input.signature) {
      const signature = input.signature;
      doc.addPage();
      doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(14).text(input.companyName);
      doc.moveDown(1.5);
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(16).text("Signature record");
      doc
        .fillColor(MUTED)
        .font("Helvetica")
        .fontSize(10)
        .text(`${input.title} for ${input.employeeName} · signed online with AuxHR`);
      doc.moveDown(1.5);
      const rows: Array<[string, string]> = [
        ["Signed by", signature.name],
        ["Email", signature.email],
        ["Signed on", lagosStamp(signature.signedAt)],
        ...(signature.sentBy && signature.sentAt
          ? ([["Sent by", `${signature.sentBy}, ${lagosStamp(signature.sentAt)}`]] as Array<
              [string, string]
            >)
          : []),
        ...(signature.openedAt
          ? ([["Opened", lagosStamp(signature.openedAt)]] as Array<[string, string]>)
          : []),
        ...(signature.check
          ? ([["Document ID", signature.check.documentId]] as Array<[string, string]>)
          : []),
        ["Check code", signature.checkCode],
      ];
      for (const [label, value] of rows) {
        doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(label.toUpperCase());
        doc.fillColor(INK).font("Helvetica").fontSize(11).text(value, { width });
        doc.moveDown(0.6);
      }
      doc.moveDown(0.5);
      doc.fillColor("#067647").font("Helvetica-Bold").fontSize(11).text("Signed");
      doc.moveDown(0.5);
      doc
        .fillColor(MUTED)
        .font("Helvetica")
        .fontSize(9)
        .text(
          signature.check
            ? `Anyone can check this code on ${signature.check.verifyUrl}. Enter the document ID and check code, or upload this file. The code is a SHA-256 fingerprint of the document, the signer, the signing time and the signer's address.`
            : "The check code is a SHA-256 fingerprint of the document text, the signer's name and the signing time. Any change to them gives a different code.",
          { width }
        );
    }

    doc.end();
  });
}
