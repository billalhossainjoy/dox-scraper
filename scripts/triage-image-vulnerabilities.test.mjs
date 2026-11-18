import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { triageTrivyReport, printTriage } from "./triage-image-vulnerabilities.mjs";

const roots = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, {recursive:true,force:true}); });
function files(api, worker = {Results: []}) {
  const dir=mkdtempSync(join(tmpdir(),"dox-triage-")); roots.push(dir);
  const paths=[join(dir,"api.json"),join(dir,"worker.json")];
  writeFileSync(paths[0],JSON.stringify(api)); writeFileSync(paths[1],JSON.stringify(worker));
  return paths;
}
test("triages OS and library vulnerabilities without printing image or target names", () => {
  const report={Results:[
    {Target:"private.example.com/private:image",Class:"os-pkgs",Vulnerabilities:[
      {Severity:"CRITICAL",VulnerabilityID:"CVE-2026-12345",PkgName:"libfoo",
        InstalledVersion:"1.0-1",FixedVersion:""},
      {Severity:"HIGH",VulnerabilityID:"CVE-2026-22222",PkgName:"libbar",
        InstalledVersion:"2.0",FixedVersion:"2.1"},
    ]},
    {Target:"secret/path",Class:"lang-pkgs",Vulnerabilities:[
      {Severity:"HIGH",VulnerabilityID:"GHSA-abcd-1234-abcd",PkgName:"@pkg/library",
        InstalledVersion:"1.0.0",FixedVersion:"1.2.0"},
    ]},
  ]};
  const details=triageTrivyReport(report);
  assert.deepEqual(details.totals,{
    critical:1,high:2,fixableCritical:0,fixableHigh:2,os:2,library:1,
  });
  const lines=[];
  printTriage(files(report),x=>lines.push(x));
  assert.ok(lines.some(x=>x.includes("CVE-2026-12345 package=libfoo")));
  assert.ok(lines.some(x=>x.includes("package=@pkg/library installed=1.0.0")));
  assert.equal(lines.join("\n").includes("private.example.com"),false);
  assert.equal(lines.join("\n").includes("secret/path"),false);
});
test("sanitizes attacker-controlled package and version fields", () => {
  const lines=[];
  printTriage(files({Results:[{Class:"os-pkgs",Vulnerabilities:[{
    Severity:"CRITICAL",VulnerabilityID:"INJECT\nTOKEN",PkgName:"secret\nleaked",
    InstalledVersion:"1.0\r\nSECRET",FixedVersion:"7.0\u001b[31m",
  }]}]}),x=>lines.push(x));
  assert.ok(lines.some(x=>x.includes("package=[redacted]")));
  assert.ok(!lines.join("\n").includes("TOKEN"));
  assert.ok(!lines.join("\n").includes("leaked"));
});
test("limits output rows and fails closed for invalid reports", () => {
  const result=triageTrivyReport({Results:[{Class:"os-pkgs",Vulnerabilities:
    Array.from({length:50},(_,i)=>({Severity:"CRITICAL",
      VulnerabilityID:"CVE-2026-"+(10000+i),PkgName:"libx",InstalledVersion:"1"}))
  }]});
  assert.equal(result.entries.length,24);
  assert.equal(result.truncated,true);
  assert.throws(()=>triageTrivyReport({Results:[{Vulnerabilities:"wrong"}]}),/Invalid/);
  assert.throws(()=>printTriage(["missing.json","missing2.json"],()=>{}),/Unable to validate/);
});
