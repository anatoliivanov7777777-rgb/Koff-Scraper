import { describe, expect, test } from "vitest";
import { ModelIndex, devicesFor, modelKey } from "../src/models.js";

const shop = new ModelIndex([
  ...["iPhone 11 Pro Max", "iPhone XS Max", "iPhone 11 Pro", "iPhone 12 Mini", "iPhone 13", "iPhone 13 Pro", "iPhone 14", "iPhone 15", "iPhone 16",
    "iPhone 18 Pro Max", "iPhone 17 Pro Max", "iPhone 18 Pro", "iPhone 7", "iPhone 8"].map((name) => ({ brand: "Apple", name })),
  ...["S26 FE", "S26 Ultra", "A55 5G", "A36 5G", "A56 5G", "S8", "A13 4G", "Galaxy Z Flip5"].map((name) => ({ brand: "Samsung", name })),
  ...["Redmi Note 12 5G", "Poco X5 5G", "Redmi 9C", "Redmi 10A", "Redmi Note 9S", "Redmi Note 9 Pro", "Redmi Note 17 Pro 5G", "Xiaomi 13 Pro", "Redmi A7 Pro 4G"]
    .map((name) => ({ brand: "Xiaomi", name })),
  ...["Moto G50 5G", "Edge 70 Max 5G", "Moto E40"].map((name) => ({ brand: "MOTO", name })),
  ...["Pixel 9 Pro XL"].map((name) => ({ brand: "Google", name })),
  ...["600 Smart 5G", "Magic6 Pro"].map((name) => ({ brand: "Honor", name })),
]);
const names = (title: string) => devicesFor(title, shop).map((d) => `${d.brand}:${d.model}`);

describe("phone models from Omax titles", () => {
  test("key ignores 4G/5G, spaces, Galaxy and brackets", () => {
    expect(modelKey("Redmi Note 14 4G (Standard)")).toBe(modelKey("Redmi Note 14"));
    expect(modelKey("Galaxy Z Flip5")).toBe("zflip5");
  });
  test.each([
    ["OG Tempered Glass Apple iPhone 11 Pro Max/Xs Max /черно/", ["Apple:iPhone 11 Pro Max", "Apple:iPhone XS Max"]],
    ["NORDIC Калъф Apple iPhone 12 Mini, Crystal Clear", ["Apple:iPhone 12 Mini"]],
    ["NORDIC Калъф Apple iPhone 18 Pro Max/ 17 Pro Max, Crystal Clear", ["Apple:iPhone 18 Pro Max", "Apple:iPhone 17 Pro Max"]],
    ["NORDIC iNstinct PRIVACY 360 Premium Glass Apple iPhone 16 /iPhone 15", ["Apple:iPhone 16", "Apple:iPhone 15"]],
    ["NORDIC instinct Tempered Glass Apple iPhone 14/iPhone 13/13 Pro /черно/", ["Apple:iPhone 14", "Apple:iPhone 13", "Apple:iPhone 13 Pro"]],
    ["NORDIC iNstinct Tempered Glass Samsung A55/A36/A56 5G /черно/", ["Samsung:A55 5G", "Samsung:A36 5G", "Samsung:A56 5G"]],
    ["Калъф Carbon Xiaomi RedMi Note 12 5G/Poco X5 5G /черен/ NORDIC", ["Xiaomi:Redmi Note 12 5G", "Xiaomi:Poco X5 5G"]],
    ["BOTER Калъф MagSafe + MagPopsocket Xiaomi RedMi 9C/RedMi 10A /AstroGolfer/", ["Xiaomi:Redmi 9C", "Xiaomi:Redmi 10A"]],
    ["Калъф Air Defender Xiaomi RedMi Note 9s/Note 9 Pro /прозрачен/", ["Xiaomi:Redmi Note 9S", "Xiaomi:Redmi Note 9 Pro"]],
    ["Калъф Business CARBON Xiaomi 13 Pro /черен/", ["Xiaomi:Xiaomi 13 Pro"]],
    ["Калъф Silicone Matt Xiaomi RedMi A7 Pro 4G /тъмно зелен/", ["Xiaomi:Redmi A7 Pro 4G"]],
    ["Camera Tempered Glass Motorola Moto G50 5G", ["MOTO:Moto G50 5G"]],
    ["NORDIC Калъф Motorola Edge 70 Max 5G, Crystal Clear", ["MOTO:Edge 70 Max 5G"]],
    ["NORDIC Калъф Google Pixel 9 Pro XL, Crystal Clear", ["Google:Pixel 9 Pro XL"]],
    ["NORDIC Калъф Honor 600 Smart 5G, Crystal Clear", ["Honor:600 Smart 5G"]],
    ["3D PRIVACY Glass Samsung S26 FE", ["Samsung:S26 FE"]],
    ["Калъф Genuine Carbon Samsung Z Flip 5 /черен/", ["Samsung:Galaxy Z Flip5"]],
    ["Camera Tempered Glass Apple iPhone 7/8", ["Apple:iPhone 7", "Apple:iPhone 8"]],
    ["BASEUS Калъф WING Samsung S8 /прозрачен/", ["Samsung:S8"]],
  ])("%s", (title, expected) => {
    expect(names(title)).toEqual(expected);
  });
  test("a tablet or an unknown phone gives nothing", () => {
    expect(names("BASEUS Tempered Glass Crystal Series HD iPad Air 13inch /2024/2025/, Easy-fix - P40012002201-03")).toEqual([]);
    expect(names("Калъф Book Pocket Oppo Reno 16 Pro 5G /черен/ MAG")).toEqual([]);
    expect(names("LDNIO 220V 20W, USB-A + USB-C, кабел C-L, бял - A2318M")).toEqual([]);
  });
});
