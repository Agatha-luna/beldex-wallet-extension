#!/usr/bin/env node
// Make an Emscripten embind glue file loadable under the MV3 CSP.
//
//   node scripts/patch-embind-csp.mjs vendor/beldex-app-bridge/BeldexLibAppCpp_WASM.js
//
// Embind's craftInvokerFunction assembles each binding's invoker as source text
// and compiles it with `newFunc(Function, args1)`. Extension pages forbid
// 'unsafe-eval' (only 'wasm-unsafe-eval' is grantable), so that throws the
// moment the first binding registers and the bridge never loads. This swaps
// the function for one that performs the identical marshalling at runtime --
// what Emscripten itself emits under -sDYNAMIC_EXECUTION=0.
//
// Idempotent: a file that is already patched is left alone. Run it on every
// freshly built glue before vendoring; test/bridge.test.mjs runs the result
// under --disallow-code-generation-from-strings and fails if a step is missed.

import { readFileSync, writeFileSync } from 'node:fs'

const MARK = 'MV3-CSP-safe rewrite of embind'
const file = process.argv[2]
if (!file) { console.error('usage: patch-embind-csp.mjs <glue.js>'); process.exit(2) }
const src = readFileSync(file, 'utf8')

if (src.includes(MARK)) { console.log(`${file}: already patched`); process.exit(0) }

const start = src.indexOf('  function craftInvokerFunction(')
if (start < 0) throw new Error('craftInvokerFunction not found -- not an embind glue, or a different Emscripten')
const tail = 'return newFunc(Function, args1).apply(null, args2);\n    }'
const endAt = src.indexOf(tail, start)
if (endAt < 0) throw new Error('could not find the end of craftInvokerFunction; the upstream shape changed, patch by hand')
const end = endAt + tail.length

const replacement = `  function craftInvokerFunction(humanName, argTypes, classType, cppInvokerFunc, cppTargetFunc, /** boolean= */ isAsync) {
      // ${MARK}'s invoker generation (scripts/patch-embind-csp.mjs).
      //
      // Upstream assembles the invoker's source as a string and compiles it with
      // \`newFunc(Function, args1)\`. Extension pages forbid 'unsafe-eval', so that
      // throws an EvalError the moment the first binding is registered and the
      // whole bridge fails to load. This performs the identical marshalling at
      // runtime instead, equivalent to Emscripten's -sDYNAMIC_EXECUTION=0 output.
      var argCount = argTypes.length;

      if (argCount < 2) {
        throwBindingError("argTypes array size mismatch! Must at least get return value and 'this' types!");
      }

      assert(!isAsync, 'Async bindings are only supported with JSPI.');

      var isClassMethodFunc = (argTypes[1] !== null && classType !== null);

      // A type with no destructorFunction cannot be torn down individually, so
      // the whole call needs a destructor stack.
      var needsDestructorStack = false;
      for (var i = 1; i < argTypes.length; ++i) {
        if (argTypes[i] !== null && argTypes[i].destructorFunction === undefined) {
          needsDestructorStack = true;
          break;
        }
      }

      var returns = (argTypes[0].name !== "void");
      var expectedArgCount = argCount - 2;

      return createNamedFunction(makeLegalFunctionName(humanName), function() {
        if (arguments.length !== expectedArgCount) {
          throwBindingError('function ' + humanName + ' called with ' + arguments.length + ' arguments, expected ' + expectedArgCount);
        }
        var destructors = needsDestructorStack ? [] : null;
        var thisWired;
        var argsWired = new Array(expectedArgCount);
        var invokerArgs = [cppTargetFunc];

        if (isClassMethodFunc) {
          thisWired = argTypes[1].toWireType(destructors, this);
          invokerArgs.push(thisWired);
        }
        for (var i = 0; i < expectedArgCount; ++i) {
          argsWired[i] = argTypes[i + 2].toWireType(destructors, arguments[i]);
          invokerArgs.push(argsWired[i]);
        }

        var rv = cppInvokerFunc.apply(null, invokerArgs);

        if (needsDestructorStack) {
          runDestructors(destructors);
        } else {
          for (var i = isClassMethodFunc ? 1 : 2; i < argTypes.length; ++i) {
            var param = (i === 1) ? thisWired : argsWired[i - 2];
            if (argTypes[i].destructorFunction !== null) {
              argTypes[i].destructorFunction(param);
            }
          }
        }

        if (returns) {
          return argTypes[0].fromWireType(rv);
        }
      });
    }`

const out = src.slice(0, start) + replacement + src.slice(end)
if (/newFunc\(Function|new Function\(/.test(out.replace(/\/\/.*$/gm, ''))) {
  throw new Error('dynamic code generation still present after patching')
}
writeFileSync(file, out)
console.log(`${file}: patched`)
