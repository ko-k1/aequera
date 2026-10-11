/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// engine.wasm (../engine, src/abi.rs): adblock-rust behind a C ABI. Inputs
// are copied into the module's memory; results come back as integers or as
// bytes at veil_out().

class VeilEngine {
  static #module = null;

  // One compiled module; each engine is an instance of it (its own memory,
  // its own rules).
  static async load() {
    VeilEngine.#module ||= fetch(browser.runtime.getURL("engine.wasm"))
      .then(response => response.arrayBuffer())
      .then(bytes => WebAssembly.compile(bytes));
    const instance = await WebAssembly.instantiate(await VeilEngine.#module, {});
    return new VeilEngine(instance.exports);
  }

  #x;
  #encoder = new TextEncoder();
  #decoder = new TextDecoder();
  // A reused input buffer for the per-request path.
  #scratch = 0;
  #scratchSize = 0;

  constructor(exports) {
    this.#x = exports;
  }

  // Memory can grow on any call: take a fresh view each time.
  #bytes() {
    return new Uint8Array(this.#x.memory.buffer);
  }

  #reserve(size) {
    if (size <= this.#scratchSize) {
      return;
    }
    if (this.#scratchSize) {
      this.#x.veil_free(this.#scratch, this.#scratchSize);
    }
    this.#scratchSize = Math.max(size, 4096);
    this.#scratch = this.#x.veil_alloc(this.#scratchSize);
  }

  // Copies strings back to back into the scratch buffer; returns
  // [pointer, length] pairs, flattened.
  #put(...strings) {
    const encoded = strings.map(s => this.#encoder.encode(s));
    this.#reserve(encoded.reduce((n, e) => n + e.length, 0));
    const memory = this.#bytes();
    const args = [];
    let at = this.#scratch;
    for (const e of encoded) {
      memory.set(e, at);
      args.push(at, e.length);
      at += e.length;
    }
    return args;
  }

  #out(length) {
    if (!length) {
      return null;
    }
    const at = this.#x.veil_out();
    return this.#decoder.decode(this.#bytes().subarray(at, at + length));
  }

  // Filter list text, lists concatenated. False on failure. The text has its
  // own allocation, freed after: the scratch buffer stays request-sized.
  compile(text) {
    const encoded = this.#encoder.encode(text);
    const at = this.#x.veil_alloc(encoded.length);
    this.#bytes().set(encoded, at);
    try {
      return this.#x.veil_compile(at, encoded.length) === 0;
    } finally {
      this.#x.veil_free(at, encoded.length);
    }
  }

  // 1 block, 0 allow, -1 unparsable, -2 no engine.
  check(url, source, type) {
    return this.#x.veil_check(...this.#put(url, source, type));
  }

  // { hide: [selector], exceptions: [selector], generichide: bool } or null.
  cosmetic(url) {
    const json = this.#out(this.#x.veil_cosmetic(...this.#put(url)));
    return json ? JSON.parse(json) : null;
  }

  // Generic selectors for the class and id names a document uses.
  generic(classes, ids, exceptions) {
    const input = JSON.stringify({ classes, ids, exceptions });
    const json = this.#out(this.#x.veil_generic(...this.#put(input)));
    return json ? JSON.parse(json) : [];
  }
}
