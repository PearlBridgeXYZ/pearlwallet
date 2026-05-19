import QRCode from "qrcode";
export async function dataUrl(text, size = 300) {
    return QRCode.toDataURL(text, {
        errorCorrectionLevel: "M",
        width: size,
        margin: 1,
        color: { dark: "#000000", light: "#ffffff" },
    });
}
