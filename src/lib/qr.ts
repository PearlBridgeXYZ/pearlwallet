import QRCode from "qrcode";

export async function dataUrl(text: string, size = 300): Promise<string> {
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: "M",
    width: size,
    margin: 1,
    color: { dark: "#000000", light: "#ffffff" },
  });
}
