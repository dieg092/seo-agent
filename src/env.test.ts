import { test } from "node:test";
import assert from "node:assert/strict";
import { getEnv } from "./env";

test("getEnv returns the value when the variable is set", () => {
  process.env.SEO_AGENT_TEST_VAR = "hello";
  assert.equal(getEnv("SEO_AGENT_TEST_VAR"), "hello");
  delete process.env.SEO_AGENT_TEST_VAR;
});

test("getEnv throws when the variable is missing", () => {
  delete process.env.SEO_AGENT_TEST_VAR;
  assert.throws(
    () => getEnv("SEO_AGENT_TEST_VAR"),
    /SEO_AGENT_TEST_VAR/
  );
});

test("getEnv throws when the variable is an empty string", () => {
  process.env.SEO_AGENT_TEST_VAR = "";
  assert.throws(
    () => getEnv("SEO_AGENT_TEST_VAR"),
    /SEO_AGENT_TEST_VAR/
  );
  delete process.env.SEO_AGENT_TEST_VAR;
});
