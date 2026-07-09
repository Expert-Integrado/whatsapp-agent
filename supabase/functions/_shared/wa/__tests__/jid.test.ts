// __tests__/jid.test.ts
import { assertEquals } from "jsr:@std/assert";
import { digitsFromJid, isGroupJid, isLidJid } from "../jid.ts";

Deno.test("digitsFromJid extrai dígitos antes do @", () => {
  assertEquals(digitsFromJid("558192030166@s.whatsapp.net"), "558192030166");
  assertEquals(digitsFromJid("120363012345678901@g.us"), "120363012345678901");
  assertEquals(digitsFromJid("5511999998888"), "5511999998888");
});

Deno.test("isGroupJid detecta @g.us", () => {
  assertEquals(isGroupJid("120363@g.us"), true);
  assertEquals(isGroupJid("5511@s.whatsapp.net"), false);
});

Deno.test("isLidJid detecta @lid", () => {
  assertEquals(isLidJid("5511@lid"), true);
  assertEquals(isLidJid("5511@s.whatsapp.net"), false);
});
