import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fixture } from "./fixture.ts";

test("existing approval page renders remote identity, update scope and duration before enabling approval", async () => {
  const { broker } = fixture();
  const request = broker.create(1000, "Connect remote", ["environment:remote"], 1800);
  class Element {
    textContent = "";
    value: string | number = "";
    disabled = false;
    hidden = false;
    children: Element[] = [];
    append(child: Element) {
      this.children.push(child);
    }
    replaceChildren() {
      this.children = [];
    }
    addEventListener() {}
  }
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    let item = elements.get(id);
    if (!item) {
      item = new Element();
      elements.set(id, item);
    }
    return item;
  };
  const context = vm.createContext({
    location: { pathname: `/access/requests/${request.id}` },
    document: { getElementById: element, createElement: () => new Element() },
    fetch: async () => ({ ok: true, json: async () => ({ request, csrf: "fixture" }) }),
  });
  vm.runInContext(readFileSync(new URL("../web/app.js", import.meta.url), "utf8"), context);
  await vm.runInContext("refresh()", context);
  const scope = element("scope").children[0]!.textContent;
  assert.match(scope, /sean@remote.example:22/);
  assert.match(scope, /Host keys:/);
  assert.match(scope, /Patched runtime installed automatically/);
  assert.equal(element("approve").disabled, false);
  assert.equal(element("duration").value, 1800);
  assert.ok(element("duration").children.some((item) => item.value === 172800));
  assert.equal(element("message").textContent, "");
  broker.close();
});
