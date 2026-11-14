import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBacklink, linksToSite } from "./backlinks";

test("encuentra enlaces a miwebdeboda.com con y sin www, y su rel", () => {
  const html = `<p><a href="https://www.miwebdeboda.com/precios" rel="nofollow">x</a> <a href='//miwebdeboda.com/'>y</a> <a href="https://miwebdeboda.com.evil.com/">z</a></p>`;
  assert.deepEqual(linksToSite(html).map((l) => l.href), ["https://www.miwebdeboda.com/precios", "//miwebdeboda.com/"]);
});

test("checkBacklink prefiere un enlace follow", () => {
  assert.deepEqual(checkBacklink(`<a href="https://miwebdeboda.com/a" rel="sponsored">a</a><a href="https://miwebdeboda.com/b">b</a>`), {
    found: true,
    follow: true,
    href: "https://miwebdeboda.com/b",
  });
  assert.deepEqual(checkBacklink(`<a rel="ugc nofollow" href="https://miwebdeboda.com/a">a</a>`), { found: true, follow: false, href: "https://miwebdeboda.com/a" });
  assert.deepEqual(checkBacklink(`<a href="https://otra.com">a</a>`), { found: false });
});
