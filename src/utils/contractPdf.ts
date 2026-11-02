import PDFDocument from "pdfkit";

export interface ContractSignature {
  name: string;
  signedAt: Date;
  ip: string;
  checkCode: string;
}

export interface ContractPdfInput {
  companyName: string;
  logo: Buffer | null;
  title: string;
  body: string;
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

const utcStamp = (date: Date): string => `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;

export async function generateContractPdf(input: ContractPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: PAGE_MARGIN,
      info: { Title: input.title, Author: input.companyName },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const width = doc.page.width - PAGE_MARGIN * 2;

    if (input.logo && isPngOrJpeg(input.logo)) {
      doc.image(input.logo, { fit: [160, 48] });
      doc.moveDown(1);
    } else {
      doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(14).text(input.companyName, { width });
      doc.moveDown(1);
    }

    doc.fillColor(INK).font("Helvetica-Bold").fontSize(20).text(input.title, { width });
    doc.moveDown(1);

    doc.fillColor(BODY).font("Helvetica").fontSize(11);
    for (const paragraph of input.body.split("\n\n")) {
      doc.text(paragraph, { width, lineGap: 3 });
      doc.moveDown(0.8);
    }

    doc.moveDown(1.5);
    doc.fillColor(MUTED).font("Helvetica").fontSize(10).text("Signed by the employee", { width });
    doc
      .fillColor(INK)
      .font("Helvetica-Bold")
      .fontSize(12)
      .text(input.signature ? input.signature.name : "____________________________", { width });
    if (input.signature) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(10).text(utcStamp(input.signature.signedAt));

      doc.addPage();
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(16).text("Electronic signature record");
      doc.moveDown(1);
      const rows: Array<[string, string]> = [
        ["Document", input.title],
        ["Company", input.companyName],
        ["Signed by", input.signature.name],
        ["Signed at", utcStamp(input.signature.signedAt)],
        ["IP address", input.signature.ip || "Unknown"],
        ["Check code", input.signature.checkCode],
      ];
      for (const [label, value] of rows) {
        doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(label.toUpperCase());
        doc.fillColor(INK).font("Helvetica").fontSize(11).text(value, { width });
        doc.moveDown(0.6);
      }
      doc.moveDown(0.5);
      doc
        .fillColor(MUTED)
        .fontSize(9)
        .text(
          "The check code is a SHA-256 fingerprint of the document text, the signer's name and the signing time. Any change to them gives a different code.",
          { width }
        );
    }

    doc.end();
  });
}
