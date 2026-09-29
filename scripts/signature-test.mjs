import { build } from 'esbuild';
import path from 'node:path';

const stubDir = path.resolve('scripts/stubs');

const result = await build({
  entryPoints: ['src/App.tsx'],
  bundle: true,
  format: 'esm',
  write: false,
  alias: {
    'react': path.join(stubDir, 'react.mjs'),
    'react/jsx-runtime': path.join(stubDir, 'react-jsx-runtime.mjs'),
    '@blueprintjs/core': path.join(stubDir, 'blueprint.mjs')
  },
  logLevel: 'silent'
});

const code = result.outputFiles[0].text;

const blob = new URL(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`, import.meta.url);
const {
  initialProcess, normalizeStepSignatures, getReviewerSignature,
  getLeaderSignature, isStepConfirmed, signableContent
} = await import(blob.href);

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log('PASS', name); }
  else { failed++; console.log('FAIL', name, '\n  expected:', expected, '\n  actual:  ', actual); }
}

function makeStep(overrides = {}) {
  const process = initialProcess();
  const step = process.steps.find((s) => s.id === 'step-3');
  step.status = 'submitted';
  step.signatures = { reviewer: null, leader: null };
  step.voidedSignatures = [];
  Object.assign(step, overrides);
  return step;
}
function sign(step, name, role) {
  return {
    name, role, basis: role === 'reviewer' ? '依据 X' : '独立确认',
    signedAt: '2026-09-29T10:00:00+08:00', signedContentHash: signableContent(step)
  };
}

// 1. 普通步骤状态确认不受双签影响
{
  const step = makeStep();
  step.highRisk = false;
  step.status = 'confirmed';
  check('普通步骤 status=confirmed 即确认', isStepConfirmed(step, '李明'), true);
}

// 2. 高危步骤双签齐备才确认
{
  const step = makeStep();
  step.signatures.reviewer = sign(step, '王颖', 'reviewer');
  check('仅首签 → 未确认', isStepConfirmed(step, '李明'), false);
  check('仅首签时无法取会签', getLeaderSignature(step, '李明'), null);
  step.signatures.leader = sign(step, '陈立', 'leader');
  check('双签齐备 → 已确认', isStepConfirmed(step, '李明'), true);
}

// 3. 首签人 == 研究员 → 无效
{
  const step = makeStep();
  step.signatures.reviewer = sign(step, '李明', 'reviewer');
  step.signatures.leader = sign(step, '陈立', 'leader');
  check('首签人是研究员 → 未确认', isStepConfirmed(step, '李明'), false);
}

// 4. 会签人 == 研究员 → 无效
{
  const step = makeStep();
  step.signatures.reviewer = sign(step, '王颖', 'reviewer');
  step.signatures.leader = sign(step, '李明', 'leader');
  check('会签人是研究员 → 未确认', isStepConfirmed(step, '李明'), false);
}

// 5. 两位签署人同名 → 无效
{
  const step = makeStep();
  step.signatures.reviewer = sign(step, '王颖', 'reviewer');
  step.signatures.leader = sign(step, '王颖', 'leader');
  check('两位签署人同一人 → 未确认', isStepConfirmed(step, '李明'), false);
}

// 6. 首签后内容变化 → 首签作废、会签连带失效、回到待复核
{
  const step = makeStep();
  step.status = 'confirmed';
  step.signatures.reviewer = sign(step, '王颖', 'reviewer');
  step.signatures.leader = sign(step, '陈立', 'leader');
  step.title = '加入催化剂并启动反应（已修改）';
  normalizeStepSignatures(step, '李明');
  check('内容变化后首签清空', step.signatures.reviewer, null);
  check('内容变化后会签清空', step.signatures.leader, null);
  check('内容变化后回到待复核', step.status, 'submitted');
  check('两条签名都进作废记录', step.voidedSignatures.length, 2);
  check('作废原因提及首签', step.voidedSignatures[0].reason.includes('首签'), true);
}

// 7. 首签不变、仅会签后内容变化 → 首签失效则会签也失效
{
  const step = makeStep();
  step.signatures.reviewer = sign(step, '王颖', 'reviewer');
  step.signatures.leader = sign(step, '陈立', 'leader');
  step.amount = '催化剂 A 3.00 g';
  normalizeStepSignatures(step, '李明');
  check('用量变化后首签清空', step.signatures.reviewer, null);
  check('用量变化后会签清空', step.signatures.leader, null);
}

// 8. 取消高危标记 → 签名作废
{
  const step = makeStep();
  step.status = 'confirmed';
  step.signatures.reviewer = sign(step, '王颖', 'reviewer');
  step.signatures.leader = sign(step, '陈立', 'leader');
  step.highRisk = false;
  normalizeStepSignatures(step, '李明');
  check('取消高危 → 签名清空', [step.signatures.reviewer, step.signatures.leader], [null, null]);
  check('取消高危且原已确认 → 回到待复核', step.status, 'submitted');
}

// 9. 已确认但签名缺失（旧数据）→ 回到待复核
{
  const step = makeStep();
  step.status = 'confirmed';
  normalizeStepSignatures(step, '李明');
  check('高危已确认但无签名 → 回到待复核', step.status, 'submitted');
}

// 10. 研究员改名后与签署人同名 → 签名退回并记录
{
  const step = makeStep();
  step.status = 'confirmed';
  step.signatures.reviewer = sign(step, '王颖', 'reviewer');
  step.signatures.leader = sign(step, '陈立', 'leader');
  normalizeStepSignatures(step, '陈立'); // 负责人改名为会签人
  check('研究员改名撞会签人 → 会签清空', step.signatures.leader, null);
  check('研究员改名撞会签人 → 回到待复核', step.status, 'submitted');
  check('退回原因写入作废记录', step.voidedSignatures.some((v) => v.reason.includes('研究员')), true);
}

// 11. 合法双签经归一化保持有效，状态保持 confirmed
{
  const step = makeStep();
  step.status = 'confirmed';
  step.signatures.reviewer = sign(step, '王颖', 'reviewer');
  step.signatures.leader = sign(step, '陈立', 'leader');
  normalizeStepSignatures(step, '李明');
  check('合法双签保留', isStepConfirmed(step, '李明'), true);
  check('合法双签无作废记录', step.voidedSignatures.length, 0);
  check('合法双签保持已确认', step.status, 'confirmed');
}

// 12. 重新首签后，新内容哈希生效
{
  const step = makeStep();
  step.signatures.reviewer = sign(step, '王颖', 'reviewer');
  step.controls = '新的控制措施';
  normalizeStepSignatures(step, '李明');
  step.signatures.reviewer = sign(step, '赵复核', 'reviewer');
  step.signatures.leader = sign(step, '陈立', 'leader');
  normalizeStepSignatures(step, '李明');
  check('重签后双签有效', isStepConfirmed(step, '李明'), true);
}

// 13. 初始数据：step-3/4 高危且待复核，冻结版快照含双签
{
  const process = initialProcess();
  const step3 = process.steps.find((s) => s.id === 'step-3');
  check('初始 step-3 标记高危', step3.highRisk, true);
  check('初始 step-3 未双签', isStepConfirmed(step3, '李明'), false);
  const frozen = process.versions[1];
  const frozenStep3 = frozen.steps.find((s) => s.id === 'step-3');
  check('冻结快照保留高危双签', isStepConfirmed(frozenStep3, '李明'), true);
  check('冻结快照双签人为不同人', frozenStep3.signatures.reviewer.name !== frozenStep3.signatures.leader.name, true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
