import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { chromium } from "playwright";

const scenarioPath = process.argv[2];
assert.match(
  scenarioPath ?? "",
  /^\.demo\/[a-zA-Z0-9_-]+\.json$/,
  "Pass a scenario JSON file directly inside .demo.",
);

const origin = process.env.DEMO_PRINT_ORIGIN ?? "http://localhost:3100";
const originUrl = new URL(origin);
assert.ok(
  ["localhost", "127.0.0.1"].includes(originUrl.hostname),
  "Print verification is restricted to the local presentation app.",
);
const browserChannel = process.env.DEMO_PRINT_BROWSER ?? "msedge";
assert.ok(["msedge", "chrome"].includes(browserChannel), "Use msedge or chrome.");

const projectId = "demo-shiftchange-v2";
const accounts = JSON.parse(await readFile(".demo/credentials.json", "utf8"));
const scenario = JSON.parse(await readFile(scenarioPath, "utf8"));
assert.equal(scenario.projectId, projectId);
assert.equal(accounts.length, 6);

const authResponse = await fetch(
  "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-presentation-key",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: accounts[1].email,
      password: accounts[1].password,
      returnSecureToken: true,
    }),
  },
);
assert.equal(authResponse.status, 200, "Supervisor must authenticate with the local Auth emulator.");
const { idToken } = await authResponse.json();
const sessionResponse = await fetch(`${origin}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin },
  body: JSON.stringify({ idToken }),
});
assert.equal(sessionResponse.status, 200, "Supervisor app session must be established.");
const cookie = sessionResponse.headers.get("set-cookie");
assert.ok(cookie, "Supervisor session cookie must be returned.");
const cookiePair = cookie.split(";")[0];
const cookieSplit = cookiePair.indexOf("=");
assert.ok(cookieSplit > 0, "Supervisor session cookie must be valid.");

const browser = await chromium.launch({ channel: browserChannel, headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 794, height: 1123 },
  });
  await context.addCookies([{
    name: cookiePair.slice(0, cookieSplit),
    value: cookiePair.slice(cookieSplit + 1),
    url: origin,
    httpOnly: true,
    sameSite: "Lax",
  }]);

  const page = await context.newPage();
  await page.goto(
    `${origin}/supervisor/handovers/${scenario.shiftId}`,
    { waitUntil: "networkidle", timeout: 180_000 },
  );
  await page.getByRole("heading", { name: "Transfer receipt", exact: true }).waitFor();
  await page.emulateMedia({ media: "print" });
  await page.evaluate(() => document.fonts.ready);

  const printState = await page.evaluate(() => {
    const article = document.querySelector(".handover-print");
    const confirmations = document.querySelector(".confirmation-evidence");
    const finalEvidence = document.querySelector(".handover-final-evidence");
    if (!article || !confirmations || !finalEvidence) {
      throw new Error("Required report evidence containers are missing.");
    }
    return {
      text: article.innerText,
      confirmationText: confirmations.innerText,
      breakInside: getComputedStyle(confirmations).breakInside,
      pageBreakInside: getComputedStyle(confirmations).pageBreakInside,
      finalBreakInside: getComputedStyle(finalEvidence).breakInside,
      printMedia: matchMedia("print").matches,
      participantRows: document.querySelectorAll(".participant-evidence-row").length,
      horizontalOverflow: article.scrollWidth > article.clientWidth + 1,
    };
  });
  assert.equal(printState.printMedia, true, "Print media must be active.");
  assert.ok(
    ["avoid-page", "avoid"].includes(printState.breakInside),
    "Participant confirmations must avoid page breaks.",
  );
  assert.equal(
    printState.pageBreakInside,
    "avoid",
    "Chromium must preserve the legacy page-break-inside alias.",
  );
  assert.equal(
    printState.finalBreakInside,
    "auto",
    "The enclosing evidence wrapper must flow across pages.",
  );
  assert.equal(printState.participantRows, 4, "All four participant rows must render.");
  assert.equal(printState.horizontalOverflow, false, "The report must not overflow horizontally.");

  const requiredSections = [
    "Shift Handover Report",
    "A. Staff information",
    "B. Attendance and reporting",
    "C. Broadcast status",
    "D. Faults and technical activities",
    "E. Outside broadcasts",
    "Pending tasks",
    "Participant evidence",
    "Authenticated report binding",
    "Transfer receipt",
    "Report SHA-256",
    "Receipt SHA-256",
  ];
  for (const section of requiredSections) {
    assert.ok(printState.text.includes(section), `Report must contain ${section}.`);
  }
  for (const account of accounts.slice(2)) {
    assert.ok(
      printState.confirmationText.includes(account.fullName),
      `Participant confirmation must include ${account.fullName}.`,
    );
  }

  const reportUrl = `${origin}/api/operations/shifts/${scenario.shiftId}/report`;
  const beforeResponse = await context.request.get(reportUrl);
  assert.ok(beforeResponse.ok(), "Completed report API must be readable.");
  const before = (await beforeResponse.json()).report;
  assert.ok(before.frozen, "The printed report must be frozen.");
  assert.ok(before.handover?.reportBinding, "Authenticated report binding must be present.");
  assert.ok(before.receipt, "Atomic transfer receipt must be present.");
  assert.equal(before.participants.length, 4);
  for (const participant of before.participants) {
    assert.equal(participant.state, "confirmed", "Every participant must have confirmed.");
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const pdfPath = `.demo/print-verification-${stamp}.pdf`;
  const screenshotPath = `.demo/print-preview-${stamp}.png`;
  const evidencePath = `.demo/print-verification-${stamp}.json`;
  const pdfBytes = await page.pdf({
    path: pdfPath,
    preferCSSPageSize: true,
    printBackground: true,
  });
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const pdfLoadingTask = getDocument({
    data: new Uint8Array(pdfBytes),
    disableWorker: true,
  });
  const pdf = await pdfLoadingTask.promise;
  const pageCount = pdf.numPages;
  assert.ok(
    pageCount >= 2 && pageCount <= 3,
    `Expected a readable two- or three-page report; got ${pageCount}.`,
  );
  const pageSizes = [];
  const extractedPages = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const pdfPage = await pdf.getPage(pageNumber);
    const [x0, y0, x1, y1] = pdfPage.view;
    const width = x1 - x0;
    const height = y1 - y0;
    assert.ok(
      Math.abs(width - 595.28) < 1.5 && Math.abs(height - 841.89) < 1.5,
      `Page ${pageNumber} must use A4 dimensions; got ${width} × ${height} points.`,
    );
    pageSizes.push({ width, height });
    const text = await pdfPage.getTextContent();
    extractedPages.push(text.items.map(item => item.str).join(" "));
  }
  await pdfLoadingTask.destroy();

  const pdfText = extractedPages.join("\n");
  for (const section of requiredSections) {
    assert.ok(pdfText.includes(section), `PDF must contain ${section}.`);
  }
  assert.ok(/carry[\s_-]?forward/i.test(pdfText), "PDF must show task disposition.");
  for (const account of accounts.slice(2)) {
    assert.ok(pdfText.includes(account.fullName), `PDF must include ${account.fullName}.`);
  }
  assert.ok(
    pdfText.includes(before.handover.reportBinding.digest),
    "PDF must include the authenticated report digest.",
  );
  assert.ok(
    pdfText.includes(before.receipt.receiptHash),
    "PDF must include the transfer receipt hash.",
  );
  assert.ok(
    pdfText.includes(before.receipt.id),
    "PDF must include the transfer receipt ID.",
  );

  const afterResponse = await context.request.get(reportUrl);
  assert.ok(afterResponse.ok(), "Report must remain readable after printing.");
  const after = (await afterResponse.json()).report;
  assert.deepEqual(after.handover.reportBinding, before.handover.reportBinding);
  assert.deepEqual(after.receipt, before.receipt);
  assert.equal(after.snapshotHash, before.snapshotHash);

  const evidence = {
    browser: await browser.version(),
    channel: browserChannel,
    scenario: scenario.shiftId,
    reportDigest: before.handover.reportBinding.digest,
    snapshotHash: before.snapshotHash,
    receiptId: before.receipt.id,
    receiptHash: before.receipt.receiptHash,
    participantNames: accounts.slice(2).map(account => account.fullName),
    participantRows: printState.participantRows,
    pageSizes,
    pageCount,
    requiredSectionsPresentInPdf: true,
    taskDispositionPresentInPdf: true,
    bindingUnchanged: true,
    receiptUnchanged: true,
    pdfPath,
    screenshotPath,
    verifiedAt: new Date().toISOString(),
  };
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { flag: "wx" });
  console.log(
    `PASS: ${evidence.browser} produced ${pdfPath}: ${pageCount} A4 pages; all sections and participant evidence present; report binding and receipt unchanged.`,
  );
  console.log(`Evidence: ${evidencePath}`);
} finally {
  await browser.close();
}
