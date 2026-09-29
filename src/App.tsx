import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  Button,
  Callout,
  Card,
  Checkbox,
  Divider,
  Elevation,
  FormGroup,
  HTMLSelect,
  Icon,
  InputGroup,
  ProgressBar,
  Switch,
  Tab,
  Tabs,
  Tag,
  TextArea
} from '@blueprintjs/core';

type StepStatus = 'draft' | 'submitted' | 'confirmed' | 'returned';
type ProcessStatus = 'draft' | 'in-review' | 'frozen' | 'revising';
type ViewId = 'editor' | 'review' | 'compare';
type SignatureRole = 'reviewer' | 'leader';

interface ReviewComment {
  id: string;
  author: string;
  role: string;
  text: string;
  createdAt: string;
  resolved: boolean;
}

interface Signature {
  name: string;
  role: SignatureRole;
  basis: string;
  signedAt: string;
  signedContentHash: string;
}

interface VoidedSignature extends Signature {
  voidedAt: string;
  reason: string;
}

interface SignatureState {
  reviewer: Signature | null;
  leader: Signature | null;
}

interface ProcessStep {
  id: string;
  title: string;
  purpose: string;
  materials: string;
  equipment: string;
  amount: string;
  duration: number;
  hazards: string[];
  controls: string;
  dependencies: string[];
  safetyNote: string;
  expectedResult: string;
  status: StepStatus;
  comments: ReviewComment[];
  highRisk: boolean;
  signatures: SignatureState;
  voidedSignatures: VoidedSignature[];
}

interface VersionSnapshot {
  id: string;
  label: string;
  version: string;
  createdAt: string;
  note: string;
  author: string;
  steps: ProcessStep[];
}

interface ExperimentProcess {
  id: string;
  title: string;
  code: string;
  objective: string;
  principal: string;
  lab: string;
  status: ProcessStatus;
  version: string;
  steps: ProcessStep[];
  versions: VersionSnapshot[];
  frozenAt?: string;
  updatedAt: string;
}

interface HistoryState {
  past: ExperimentProcess[];
  present: ExperimentProcess;
  future: ExperimentProcess[];
}

interface DiffItem {
  id: string;
  title: string;
  kind: 'added' | 'removed' | 'changed';
  detail: string;
}

const STORAGE_KEY = 'sologsb-1027-lab-safety-v1';
const CURRENT_AUTHOR = '周宁';
const CURRENT_ROLE = '安全复核员';
const SIGNATURE_FIELDS = [
  'title', 'purpose', 'materials', 'equipment', 'amount', 'duration',
  'hazards', 'controls', 'dependencies', 'safetyNote', 'expectedResult'
] as const;
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 参与签署的步骤内容：任一变化都会导致签名失效。 */
export function signableContent(step: ProcessStep): string {
  return JSON.stringify(SIGNATURE_FIELDS.map((field) => step[field]));
}

function voidSignature(step: ProcessStep, signature: Signature, reason: string): void {
  step.voidedSignatures.push({ ...signature, voidedAt: new Date().toISOString(), reason });
}

function voidAllSignatures(step: ProcessStep, reason: string): void {
  if (step.signatures.reviewer) voidSignature(step, step.signatures.reviewer, reason);
  if (step.signatures.leader) voidSignature(step, step.signatures.leader, reason);
  step.signatures = { reviewer: null, leader: null };
}

/**
 * 提交后的统一校验：
 * - 高危步骤首签后内容变化 → 首签作废、负责人会签连带失效，步骤回到待复核；
 * - 取消高危标记 → 签名整体作废；
 * - 签署人与研究员（负责人）同名，或两位签署人为同一人 → 该签署作废并退回；
 * - 已确认但双签不齐（旧数据等）→ 退回待复核。
 */
export function normalizeStepSignatures(step: ProcessStep, researcher: string): void {
  if (!step.highRisk) {
    if (step.signatures.reviewer || step.signatures.leader) {
      voidAllSignatures(step, '步骤取消高危标记，签署记录作废');
      if (step.status === 'confirmed') step.status = 'submitted';
    }
    return;
  }
  const contentHash = signableContent(step);
  const principal = researcher.trim();

  const reviewer = step.signatures.reviewer;
  if (reviewer) {
    if (reviewer.signedContentHash !== contentHash) {
      voidSignature(step, reviewer, '首签后步骤内容发生变化，首签立即作废并回到待复核');
      step.signatures.reviewer = null;
    } else if (principal && reviewer.name === principal) {
      voidSignature(step, reviewer, '签署人与研究员（负责人）为同一人，首签退回');
      step.signatures.reviewer = null;
    }
  }

  const leader = step.signatures.leader;
  if (leader) {
    const currentReviewer = step.signatures.reviewer;
    const contentChanged = leader.signedContentHash !== contentHash;
    const lostReviewer = !currentReviewer;
    const sameAsReviewer = currentReviewer ? leader.name === currentReviewer.name : false;
    const sameAsResearcher = !!principal && leader.name === principal;
    if (contentChanged || lostReviewer || sameAsReviewer || sameAsResearcher) {
      const reason = contentChanged
        ? '签署内容发生变化，负责人会签作废'
        : sameAsResearcher
          ? '签署人与研究员（负责人）为同一人，会签退回'
          : '首签作废或与首签人相同，会签一并退回';
      voidSignature(step, leader, reason);
      step.signatures.leader = null;
    }
  }

  if (step.status === 'confirmed' && !(step.signatures.reviewer && step.signatures.leader)) {
    step.status = 'submitted';
  }
}

function migrateStep(step: ProcessStep): void {
  if (typeof step.highRisk !== 'boolean') step.highRisk = false;
  if (!step.signatures) step.signatures = { reviewer: null, leader: null };
  if (!Array.isArray(step.voidedSignatures)) step.voidedSignatures = [];
  [step.signatures.reviewer, step.signatures.leader].forEach((signature) => {
    if (signature && !signature.signedContentHash) signature.signedContentHash = signableContent(step);
  });
}

type SeedStep = Omit<ProcessStep, 'highRisk' | 'signatures' | 'voidedSignatures'>;

function seedSignatures(step: Pick<ProcessStep, (typeof SIGNATURE_FIELDS)[number]>, signedAt: string): SignatureState {
  const hash = signableContent(step as ProcessStep);
  return {
    reviewer: {
      name: '王颖', role: 'reviewer', basis: '已核对危险项、控制措施与通风、应急条件，符合高危作业要求。',
      signedAt, signedContentHash: hash
    },
    leader: {
      name: '陈立', role: 'leader', basis: '已独立复核风险评估与控制措施，同意安排高危作业。',
      signedAt, signedContentHash: hash
    }
  };
}

export function initialProcess(): ExperimentProcess {
  const seedSteps: SeedStep[] = [
    {
      id: 'step-1', title: '核对试剂与实验区域', purpose: '确认所需物料、设备及区域状态符合实验方案。',
      materials: '无水乙醇、去离子水', equipment: '通风柜、防爆柜、标签打印机', amount: '乙醇 120 mL；去离子水 300 mL',
      duration: 15, hazards: ['易燃液体'], controls: '在通风柜内取用，远离点火源；使用接地金属容器。',
      dependencies: [], safetyNote: '操作人员需佩戴护目镜和防化手套。', expectedResult: '试剂标签、数量和有效期均核对无误。',
      status: 'confirmed', comments: [
        { id: 'c-1', author: '李明', role: '研究员', text: '已核对批号和有效期，防爆柜温度记录正常。', createdAt: '2026-09-24T09:10:00+08:00', resolved: true }
      ]
    },
    {
      id: 'step-2', title: '搭建恒温循环装置', purpose: '连接循环浴与反应夹套，检查密封和温控。',
      materials: '无', equipment: '恒温循环浴、硅胶管、反应夹套、扎带', amount: '循环液 800 mL',
      duration: 25, hazards: ['烫伤', '管路脱落'], controls: '管路双端固定；升温前完成 5 分钟试压并设置独立超温断电。',
      dependencies: ['step-1'], safetyNote: '高温表面设置警示标识，循环浴周围保持干燥。', expectedResult: '30 分钟内温度稳定在 55 ± 0.5 ℃。',
      status: 'confirmed', comments: [
        { id: 'c-2', author: '王颖', role: '安全复核员', text: '补充超温断电值，不能只依赖设备自带温控。', createdAt: '2026-09-24T10:05:00+08:00', resolved: true }
      ]
    },
    {
      id: 'step-3', title: '加入催化剂并启动反应', purpose: '按批次加入催化剂，记录起点并开始计时。',
      materials: '催化剂 A', equipment: '分析天平、加料漏斗、计时器', amount: '催化剂 A 2.50 ± 0.02 g',
      duration: 20, hazards: ['粉尘吸入', '放热反应'], controls: '在通风柜内称量，佩戴 N95 口罩；分三次少量加入并监测温度。',
      dependencies: ['step-2'], safetyNote: '反应温度超过 70 ℃ 时立即停止加料并启动冷却。', expectedResult: '温度缓慢升至 62–66 ℃，无明显冲料。',
      status: 'submitted', comments: []
    },
    {
      id: 'step-4', title: '恒温反应与过程取样', purpose: '维持温度并定时取样观察反应转化。',
      materials: '样品瓶、惰性气体', equipment: '取样针、气相色谱、恒温循环浴', amount: '每点样品约 1 mL，共 6 点',
      duration: 90, hazards: ['高温液体', '挥发性气体'], controls: '取样前泄压；使用长针和防护屏；样品瓶及时封闭。',
      dependencies: ['step-3'], safetyNote: '取样时不得正对瓶口，样品瓶不得完全密封后加热。', expectedResult: '转化率达到 95% 以上且无异常副产物。',
      status: 'submitted', comments: []
    },
    {
      id: 'step-5', title: '停止加热并冷却', purpose: '终止反应并将体系降至安全温度。',
      materials: '无', equipment: '循环浴、温度探头', amount: '降温目标 ≤ 30 ℃', duration: 35,
      hazards: ['烫伤', '残余反应'], controls: '先停止加料并维持搅拌，再以不超过 1 ℃/min 的速率降温。',
      dependencies: ['step-4'], safetyNote: '确认温度连续 5 分钟低于 30 ℃ 后才能拆除装置。', expectedResult: '体系温度稳定低于 30 ℃。',
      status: 'draft', comments: []
    },
    {
      id: 'step-6', title: '废液分类与现场恢复', purpose: '按危险废物要求分类收集并恢复实验区域。',
      materials: '废液桶、吸附棉', equipment: '防化手套、护目镜、危废标签', amount: '按实际产生量记录', duration: 25,
      hazards: ['废液混装', '化学暴露'], controls: '有机废液单独收集，核对相容性后贴标签；泄漏吸附材料按危废处置。',
      dependencies: ['step-5'], safetyNote: '废液不得倒入下水道，现场恢复后完成双人确认。', expectedResult: '废液交接记录完整，台面无残留。',
      status: 'draft', comments: []
    }
  ];

  const HIGH_RISK_SEED = new Set(['step-3', 'step-4']);
  const baseSteps: ProcessStep[] = seedSteps.map((step) => ({
    ...step,
    highRisk: HIGH_RISK_SEED.has(step.id),
    signatures: { reviewer: null, leader: null },
    voidedSignatures: []
  }));

  const firstVersion: VersionSnapshot = {
    id: 'version-1-0', label: '首版批准流程', version: '1.0.0', createdAt: '2026-09-20T14:30:00+08:00',
    note: '建立基础反应与取样步骤。', author: '王颖',
    steps: clone(baseSteps).slice(0, 4).map((step) => ({
      ...step, status: 'confirmed' as StepStatus, comments: [],
      signatures: step.highRisk ? seedSignatures(step, '2026-09-20T14:10:00+08:00') : { reviewer: null, leader: null },
      voidedSignatures: []
    }))
  };
  const secondVersion: VersionSnapshot = {
    id: 'version-1-1', label: '补充冷却与废液步骤', version: '1.1.0', createdAt: '2026-09-24T15:10:00+08:00',
    note: '增加安全冷却、废液处置和现场恢复。', author: '王颖',
    steps: clone(baseSteps).map((step) => ({
      ...step, status: 'confirmed' as StepStatus, comments: [],
      signatures: step.highRisk ? seedSignatures(step, '2026-09-24T14:50:00+08:00') : { reviewer: null, leader: null },
      voidedSignatures: []
    }))
  };

  return {
    id: 'exp-catalyst-2026-09', title: '负载型催化剂评价实验', code: 'SAFE-CAT-026',
    objective: '在受控温度下评价催化剂活性，并完整记录过程样品与安全控制措施。',
    principal: '李明', lab: '材料化学实验室 B-207',
    status: 'in-review', version: '1.2.0-draft',
    steps: baseSteps, versions: [firstVersion, secondVersion], updatedAt: new Date().toISOString()
  };
}

function historyReducer(state: HistoryState, action:
  | { type: 'commit'; update: (draft: ExperimentProcess) => void }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset'; value: ExperimentProcess }
): HistoryState {
  if (action.type === 'commit') {
    const next = clone(state.present);
    action.update(next);
    next.steps.forEach((step) => normalizeStepSignatures(step, next.principal));
    next.updatedAt = new Date().toISOString();
    return { past: [...state.past.slice(-59), clone(state.present)], present: next, future: [] };
  }
  if (action.type === 'undo') {
    const previous = state.past.at(-1);
    if (!previous) return state;
    return { past: state.past.slice(0, -1), present: previous, future: [clone(state.present), ...state.future].slice(0, 60) };
  }
  if (action.type === 'redo') {
    const next = state.future[0];
    if (!next) return state;
    return { past: [...state.past, clone(state.present)].slice(-60), present: next, future: state.future.slice(1) };
  }
  return { past: [], present: action.value, future: [] };
}

function loadProcess(): ExperimentProcess {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (!value) return initialProcess();
    const parsed = JSON.parse(value) as ExperimentProcess;
    if (!parsed.id || !Array.isArray(parsed.steps)) return initialProcess();
    parsed.steps.forEach(migrateStep);
    parsed.versions.forEach((version) => version.steps.forEach(migrateStep));
    return parsed;
  } catch {
    return initialProcess();
  }
}

function splitList(value: string): string[] {
  return value.split(/[\n,，、;；]+/).map((item) => item.trim()).filter(Boolean);
}

function statusLabel(status: StepStatus): string {
  return status === 'confirmed' ? '已确认' : status === 'returned' ? '已退回' : status === 'submitted' ? '待复核' : '草稿';
}

/** 高危步骤展示双签进度，普通步骤沿用原状态。 */
function stepStateLabel(step: ProcessStep, researcher: string): string {
  if (!step.highRisk) return statusLabel(step.status);
  if (isStepConfirmed(step, researcher)) return '双签已齐';
  if (step.status === 'returned') return '已退回';
  if (getReviewerSignature(step)) return '待负责人会签';
  return '待双签';
}

function processStatusLabel(status: ProcessStatus): string {
  return status === 'frozen' ? '已冻结' : status === 'in-review' ? '复核中' : status === 'revising' ? '修订中' : '草稿';
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date);
}

function formatFullDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(date);
}

/** 复核员首签：必须存在且内容未变。 */
export function getReviewerSignature(step: ProcessStep): Signature | null {
  if (!step.highRisk) return null;
  const reviewer = step.signatures.reviewer;
  return reviewer && reviewer.signedContentHash === signableContent(step) ? reviewer : null;
}

/** 实验负责人会签：首签有效、双方不同人、且都与研究员不同。 */
export function getLeaderSignature(step: ProcessStep, researcher: string): Signature | null {
  const reviewer = getReviewerSignature(step);
  const leader = step.signatures.leader;
  const principal = researcher.trim();
  if (!reviewer || !leader || !principal) return null;
  if (leader.signedContentHash !== signableContent(step)) return null;
  if (leader.name === reviewer.name || leader.name === principal || reviewer.name === principal) return null;
  return leader;
}

export function isStepConfirmed(step: ProcessStep, researcher: string): boolean {
  if (!step.highRisk) return step.status === 'confirmed';
  return !!getReviewerSignature(step) && !!getLeaderSignature(step, researcher);
}

function App() {
  const [history, dispatch] = useReducer(historyReducer, undefined, () => ({ past: [], present: loadProcess(), future: [] }));
  const process = history.present;
  const [selectedStepId, setSelectedStepId] = useState(process.steps[0]?.id ?? '');
  const [activeView, setActiveView] = useState<ViewId>('editor');
  const [lastModifiedId, setLastModifiedId] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [savedLabel, setSavedLabel] = useState('本地数据已载入');
  const [online, setOnline] = useState(true);
  const [compareBaseId, setCompareBaseId] = useState(process.versions[0]?.id ?? '');
  const [compareTargetId, setCompareTargetId] = useState(process.versions.at(-1)?.id ?? '');
  const [reviewerName, setReviewerName] = useState(CURRENT_AUTHOR);
  const [reviewerBasis, setReviewerBasis] = useState('');
  const [leaderName, setLeaderName] = useState('');
  const [leaderAck, setLeaderAck] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const initialSaveSkipped = useRef(false);

  const selectedStep = process.steps.find((step) => step.id === selectedStepId) ?? process.steps[0];
  const downstreamIds = useMemo(() => collectDownstream(process.steps, lastModifiedId), [process.steps, lastModifiedId]);
  const impactedSteps = process.steps.filter((step) => downstreamIds.includes(step.id));
  const missingSafetySteps = process.steps.filter(hasMissingSafety);
  const pendingReviewCount = process.steps.filter((step) => step.status === 'submitted' || step.status === 'returned').length;
  const confirmedCount = process.steps.filter((step) => isStepConfirmed(step, process.principal)).length;
  const highRiskSteps = process.steps.filter((step) => step.highRisk);
  const highRiskReadySteps = highRiskSteps.filter((step) => isStepConfirmed(step, process.principal));
  const reviewProgress = process.steps.length ? Math.round((confirmedCount / process.steps.length) * 100) : 0;
  const versionDiff = useMemo(() => compareVersions(process, compareBaseId, compareTargetId), [process, compareBaseId, compareTargetId]);

  useEffect(() => {
    if (!initialSaveSkipped.current) {
      initialSaveSkipped.current = true;
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(process));
    setSavedLabel(`自动保存 · ${formatDate(new Date().toISOString())}`);
  }, [process]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (!modifier) return;
      if (event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? dispatch({ type: 'redo' }) : dispatch({ type: 'undo' });
      } else if (event.key.toLowerCase() === 'y') {
        event.preventDefault();
        dispatch({ type: 'redo' });
      } else if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(process));
        setSavedLabel(`手动保存 · ${formatDate(new Date().toISOString())}`);
      }
    };
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [process]);

  // 切换步骤时重置双签表单，避免把上一步填写的姓名带到另一步骤。
  useEffect(() => {
    setReviewerName(CURRENT_AUTHOR);
    setReviewerBasis('');
    setLeaderName('');
    setLeaderAck(false);
    setSignError(null);
  }, [selectedStepId]);

  const commitProcess = (update: (draft: ExperimentProcess) => void): void => {
    dispatch({ type: 'commit', update });
  };

  const updateProcessField = (field: 'title' | 'code' | 'objective' | 'principal' | 'lab', value: string): void => {
    commitProcess((draft) => { draft[field] = value; });
  };

  const updateStep = (field: keyof ProcessStep, value: unknown): void => {
    if (!selectedStep) return;
    const id = selectedStep.id;
    setLastModifiedId(id);
    commitProcess((draft) => {
      const step = draft.steps.find((item) => item.id === id);
      if (step) (step as unknown as Record<string, unknown>)[field] = value;
    });
  };

  const updateStepList = (field: 'hazards' | 'dependencies', value: string): void => {
    updateStep(field, splitList(value));
  };

  const addStep = (): void => {
    if (process.status === 'frozen') return;
    const id = uid('step');
    commitProcess((draft) => {
      draft.steps.push({
        id, title: '新的实验步骤', purpose: '', materials: '', equipment: '', amount: '', duration: 10,
        hazards: [], controls: '', dependencies: draft.steps.at(-1) ? [draft.steps.at(-1)!.id] : [],
        safetyNote: '', expectedResult: '', status: 'draft', comments: [],
        highRisk: false, signatures: { reviewer: null, leader: null }, voidedSignatures: []
      });
      draft.status = 'draft';
    });
    setSelectedStepId(id);
    setLastModifiedId(id);
    setActiveView('editor');
  };

  const duplicateStep = (): void => {
    if (!selectedStep || process.status === 'frozen') return;
    const copy: ProcessStep = clone(selectedStep);
    copy.id = uid('step');
    copy.title = `${copy.title}（副本）`;
    copy.status = 'draft';
    copy.comments = [];
    copy.dependencies = [...copy.dependencies];
    copy.signatures = { reviewer: null, leader: null };
    copy.voidedSignatures = [];
    commitProcess((draft) => {
      const index = draft.steps.findIndex((step) => step.id === selectedStep.id);
      draft.steps.splice(index + 1, 0, copy);
    });
    setSelectedStepId(copy.id);
  };

  const deleteStep = (): void => {
    if (!selectedStep || process.steps.length <= 1 || process.status === 'frozen') return;
    const id = selectedStep.id;
    commitProcess((draft) => {
      draft.steps = draft.steps.filter((step) => step.id !== id);
      draft.steps.forEach((step) => { step.dependencies = step.dependencies.filter((dependency) => dependency !== id); });
    });
    setSelectedStepId(process.steps.find((step) => step.id !== id)?.id ?? '');
  };

  const moveStep = (direction: -1 | 1): void => {
    if (!selectedStep || process.status === 'frozen') return;
    const id = selectedStep.id;
    commitProcess((draft) => {
      const index = draft.steps.findIndex((step) => step.id === id);
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= draft.steps.length) return;
      const [step] = draft.steps.splice(index, 1);
      draft.steps.splice(nextIndex, 0, step);
    });
    setLastModifiedId(id);
  };

  const toggleDependency = (dependencyId: string, checked: boolean): void => {
    if (!selectedStep) return;
    const next = checked
      ? [...new Set([...selectedStep.dependencies, dependencyId])]
      : selectedStep.dependencies.filter((id) => id !== dependencyId);
    updateStep('dependencies', next);
  };

  const submitForReview = (): void => {
    if (process.status === 'frozen') return;
    commitProcess((draft) => {
      draft.status = 'in-review';
      draft.steps.forEach((step) => {
        if (!isStepConfirmed(step, draft.principal)) step.status = 'submitted';
      });
    });
    setActiveView('review');
    setSavedLabel('流程已提交复核');
  };

  const addReviewComment = (): void => {
    if (!selectedStep || !commentText.trim()) return;
    const id = selectedStep.id;
    commitProcess((draft) => {
      const step = draft.steps.find((item) => item.id === id);
      step?.comments.push({
        id: uid('comment'), author: CURRENT_AUTHOR, role: CURRENT_ROLE,
        text: commentText.trim(), createdAt: new Date().toISOString(), resolved: false
      });
    });
    setCommentText('');
  };

  const setStepStatus = (status: StepStatus): void => {
    if (!selectedStep) return;
    updateStep('status', status);
    setLastModifiedId(status === 'returned' ? selectedStep.id : null);
  };

  /** 高危步骤退回 / 恢复待复核时，已完成的签署一并作废。 */
  const resetHighRiskSignatures = (status: StepStatus, reason: string): void => {
    if (!selectedStep) return;
    const id = selectedStep.id;
    commitProcess((draft) => {
      const step = draft.steps.find((item) => item.id === id);
      if (!step) return;
      step.status = status;
      if (step.highRisk) voidAllSignatures(step, reason);
    });
    setSignError(null);
    setLastModifiedId(status === 'returned' ? id : null);
  };

  /** 违规签署（与研究员/首签人同一人）：不写入签名，直接退回步骤。 */
  const rejectSignature = (stepId: string, message: string): void => {
    setSignError(message);
    commitProcess((draft) => {
      const step = draft.steps.find((item) => item.id === stepId);
      if (step) step.status = 'returned';
    });
    setSavedLabel('签署被退回：需两名不同责任人分别签署');
  };

  const addSignature = (role: SignatureRole): void => {
    if (!selectedStep) return;
    const step = selectedStep;
    if (!step.highRisk) return;
    if (hasMissingSafety(step)) {
      setSignError('当前步骤存在危险项但缺少控制措施或安全说明，补齐前不能签署。');
      return;
    }
    const researcher = process.principal.trim();
    if (!researcher) {
      setSignError('实验基本信息中缺少研究员（负责人）姓名，无法核验签名回避关系。');
      return;
    }
    const name = (role === 'reviewer' ? reviewerName : leaderName).trim();
    if (!name) {
      setSignError(role === 'reviewer' ? '请填写复核员姓名后再签署。' : '请填写实验负责人姓名后再签署。');
      return;
    }
    if (role === 'reviewer' && !reviewerBasis.trim()) {
      setSignError('复核员首签必须填写复核依据。');
      return;
    }
    if (role === 'leader' && !leaderAck) {
      setSignError('实验负责人须勾选“已独立复核”后才能独立确认。');
      return;
    }
    if (name === researcher) {
      rejectSignature(step.id, `签署人“${name}”与研究员为同一人，不能自行签署高危步骤，已退回。`);
      return;
    }
    if (role === 'reviewer' && step.signatures.reviewer) {
      rejectSignature(step.id, '复核员已完成首签，不能由同一人重复签署，已退回。');
      return;
    }
    if (role === 'leader') {
      if (!getReviewerSignature(step)) {
        setSignError('复核员首签缺失或已因内容变化作废，请先完成首签。');
        return;
      }
      if (step.signatures.leader) {
        rejectSignature(step.id, '实验负责人已完成会签，不能由同一人重复签署，已退回。');
        return;
      }
      if (name === step.signatures.reviewer!.name) {
        rejectSignature(step.id, `实验负责人“${name}”与首签复核员为同一人，高危步骤须两人独立签署，已退回。`);
        return;
      }
    }

    const id = step.id;
    const basis = role === 'reviewer'
      ? reviewerBasis.trim()
      : '实验负责人已独立复核危险项、控制措施与应急条件，确认可以作业。';
    commitProcess((draft) => {
      const target = draft.steps.find((item) => item.id === id);
      if (!target) return;
      const signature: Signature = {
        name, role, basis, signedAt: new Date().toISOString(), signedContentHash: signableContent(target)
      };
      if (role === 'reviewer') {
        target.signatures.reviewer = signature;
        target.signatures.leader = null;
        target.status = 'submitted';
      } else {
        target.signatures.leader = signature;
        target.status = 'confirmed';
      }
    });
    setSignError(null);
    if (role === 'reviewer') {
      setReviewerBasis('');
      setSavedLabel('复核员首签完成，等待实验负责人独立确认');
    } else {
      setLeaderName('');
      setLeaderAck(false);
      setSavedLabel('高危步骤双签齐备，已确认');
    }
  };

  const resolveComment = (commentId: string): void => {
    if (!selectedStep) return;
    const stepId = selectedStep.id;
    commitProcess((draft) => {
      const comment = draft.steps.find((step) => step.id === stepId)?.comments.find((item) => item.id === commentId);
      if (comment) comment.resolved = !comment.resolved;
    });
  };

  const freezeBlockedReason = (): string | null => {
    if (process.status === 'frozen') return '当前版本已冻结。';
    if (process.steps.some((step) => !isStepConfirmed(step, process.principal))) {
      return '冻结条件未满足：仍有步骤未确认，或高危步骤双签未齐。';
    }
    if (missingSafetySteps.length) return '冻结条件未满足：仍存在安全信息缺口。';
    return null;
  };

  const freezeVersion = (): void => {
    const reason = freezeBlockedReason();
    if (reason) {
      setSavedLabel(reason);
      return;
    }
    const nextNumber = nextMinorVersion(process.version);
    const previousVersionId = process.versions.at(-1)?.id ?? '';
    const frozenVersionId = uid('version');
    commitProcess((draft) => {
      draft.versions.push({
        id: frozenVersionId, label: '复核通过冻结版', version: nextNumber,
        createdAt: new Date().toISOString(),
        note: `${draft.steps.length} 个步骤全部确认，安全控制完整；其中 ${draft.steps.filter((step) => step.highRisk).length} 个高危步骤双签齐备，签名随版本保留。`,
        author: CURRENT_AUTHOR, steps: clone(draft.steps)
      });
      draft.version = nextNumber;
      draft.status = 'frozen';
      draft.frozenAt = new Date().toISOString();
    });
    setSavedLabel(`版本 ${nextNumber} 已冻结`);
    setCompareBaseId(previousVersionId);
    setCompareTargetId(frozenVersionId);
  };

  const startRevision = (): void => {
    if (process.status !== 'frozen') return;
    commitProcess((draft) => {
      const nextNumber = nextMinorVersion(draft.version);
      draft.version = `${nextNumber}-revision`;
      draft.status = 'revising';
      draft.frozenAt = undefined;
      draft.steps.forEach((step) => {
        step.status = 'draft';
        step.comments = [];
        // 签名属于被冻结的旧版本，修订稿重新走双签；作废记录随冻结快照保留。
        step.signatures = { reviewer: null, leader: null };
      });
    });
    setActiveView('editor');
    setSavedLabel('已从冻结版本创建修订稿，高危步骤需重新双签');
  };

  const addVersionSnapshot = (): void => {
    commitProcess((draft) => {
      draft.versions.push({
        id: uid('version'), label: '工作版本快照', version: draft.version.replace('-draft', ''),
        createdAt: new Date().toISOString(), note: '保存当前步骤、复核状态与有效签名。',
        author: CURRENT_AUTHOR, steps: clone(draft.steps)
      });
    });
    setSavedLabel('已保存工作版本快照（含双签记录）');
  };

  const reviewerSig = selectedStep ? getReviewerSignature(selectedStep) : null;
  const leaderSig = selectedStep ? getLeaderSignature(selectedStep, process.principal) : null;
  const freezeReady = !freezeBlockedReason();

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <div className="brand-icon"><Icon icon="lab-test" size={23} /></div>
          <div><h1>实验流程安全复核台</h1><p>步骤影响分析 · 高危双签 · 冻结版本</p></div>
        </div>
        <div className="header-status">
          <span className={`network ${online ? 'online' : ''}`}></span>
          <span>{online ? '离线保存已启用' : '当前离线，修改仍会保存'}</span>
          <strong>{savedLabel}</strong>
        </div>
        <div className="header-actions">
          <Button icon="undo" text="撤销" minimal disabled={history.past.length === 0} onClick={() => dispatch({ type: 'undo' })} />
          <Button icon="redo" text="重做" minimal disabled={history.future.length === 0} onClick={() => dispatch({ type: 'redo' })} />
          <Button icon="floppy-disk" text="保存快照" onClick={addVersionSnapshot} />
          <Button icon="lock" text="冻结版本" intent="primary" onClick={freezeVersion} disabled={process.status === 'frozen'} />
        </div>
      </header>

      {!online && <Callout className="offline-callout" intent="warning" icon="cloud">网络不可用。编辑、复核和版本快照仍会保存在当前浏览器。</Callout>}

      <section className="process-banner">
        <div className="banner-main">
          <div className="code-line"><span>{process.code}</span><Tag minimal>{processStatusLabel(process.status)}</Tag></div>
          <h2>{process.title}</h2>
          <p>{process.objective}</p>
        </div>
        <div className="banner-meta">
          <div><span>负责人 / 研究员</span><strong>{process.principal}</strong></div>
          <div><span>实验区域</span><strong>{process.lab}</strong></div>
          <div><span>当前版本</span><strong>{process.version}</strong></div>
        </div>
        <div className="banner-progress">
          <div><span>复核进度</span><strong>{confirmedCount}/{process.steps.length}</strong></div>
          <ProgressBar value={reviewProgress / 100} intent={reviewProgress === 100 ? 'success' : 'primary'} stripes={reviewProgress < 100} />
          <small>{pendingReviewCount ? `${pendingReviewCount} 条待处理` : '所有步骤已处理'} · {missingSafetySteps.length} 条安全缺口 · 高危双签 {highRiskReadySteps.length}/{highRiskSteps.length}</small>
        </div>
      </section>

      <Tabs id="workspace-tabs" selectedTabId={activeView} onChange={(value) => setActiveView(value as ViewId)} renderActiveTabPanelOnly className="workspace-tabs">
        <Tab id="editor" title={<span><Icon icon="edit" /> 流程编写</span>} />
        <Tab id="review" title={<span><Icon icon="endorsed" /> 安全复核 {pendingReviewCount > 0 && <b className="tab-badge">{pendingReviewCount}</b>}</span>} />
        <Tab id="compare" title={<span><Icon icon="comparison" /> 版本比较</span>} />
      </Tabs>

      {activeView === 'editor' && selectedStep && (
        <main className="editor-layout">
          <aside className="step-panel">
            <div className="panel-heading">
              <div><span>PROCESS STEPS</span><h3>实验步骤</h3></div>
              <Button icon="add" minimal small onClick={addStep} disabled={process.status === 'frozen'} />
            </div>
            <div className="step-list">
              {process.steps.map((step, index) => (
                <button key={step.id} className={step.id === selectedStep.id ? 'selected' : ''} onClick={() => setSelectedStepId(step.id)}>
                  <span className={`step-number ${step.status}`}>{String(index + 1).padStart(2, '0')}</span>
                  <span className="step-copy">
                    <strong>{step.title}</strong>
                    <small>
                      {step.duration} 分钟 · {stepStateLabel(step, process.principal)}
                      {step.highRisk && <em className="highrisk-flag">高危双签</em>}
                    </small>
                  </span>
                  {hasMissingSafety(step)
                    ? <Icon icon="warning-sign" intent="danger" size={13} />
                    : step.highRisk
                      ? <Icon icon="shield" intent={isStepConfirmed(step, process.principal) ? 'success' : 'warning'} size={13} />
                      : null}
                </button>
              ))}
            </div>
            <div className="step-actions">
              <Button icon="arrow-up" small minimal disabled={process.steps[0]?.id === selectedStep.id || process.status === 'frozen'} onClick={() => moveStep(-1)} />
              <Button icon="arrow-down" small minimal disabled={process.steps.at(-1)?.id === selectedStep.id || process.status === 'frozen'} onClick={() => moveStep(1)} />
              <Button icon="duplicate" small minimal text="复制" disabled={process.status === 'frozen'} onClick={duplicateStep} />
              <Button icon="trash" small minimal intent="danger" disabled={process.status === 'frozen'} onClick={deleteStep} />
            </div>
          </aside>

          <section className="editor-main">
            <Card elevation={Elevation.ONE} className="process-meta-card">
              <div className="card-title"><div><span>PROCESS INFO</span><h3>实验基本信息</h3></div><Tag minimal intent="primary">{process.steps.length} 个步骤</Tag></div>
              <div className="meta-grid">
                <FormGroup label="实验名称" labelFor="process-title"><InputGroup id="process-title" fill value={process.title} onChange={(event) => updateProcessField('title', event.target.value)} /></FormGroup>
                <FormGroup label="流程编号" labelFor="process-code"><InputGroup id="process-code" fill value={process.code} onChange={(event) => updateProcessField('code', event.target.value)} /></FormGroup>
                <FormGroup label="负责人 / 研究员（签署回避对象）" labelFor="principal"><InputGroup id="principal" fill value={process.principal} onChange={(event) => updateProcessField('principal', event.target.value)} /></FormGroup>
                <FormGroup label="实验区域" labelFor="lab"><InputGroup id="lab" fill value={process.lab} onChange={(event) => updateProcessField('lab', event.target.value)} /></FormGroup>
              </div>
              <FormGroup label="实验目标" labelFor="objective"><TextArea id="objective" fill value={process.objective} onChange={(event) => updateProcessField('objective', event.target.value)} /></FormGroup>
            </Card>

            <Card elevation={Elevation.ONE} className="step-editor-card">
              <div className="card-title">
                <div><span>STEP {String(process.steps.indexOf(selectedStep) + 1).padStart(2, '0')}</span><h3>{selectedStep.title}</h3></div>
                <div className="step-title-tags">
                  {selectedStep.highRisk && <Tag minimal intent="danger" icon="shield">高危 · 需双签</Tag>}
                  <Tag minimal intent={isStepConfirmed(selectedStep, process.principal) ? 'success' : selectedStep.status === 'returned' ? 'danger' : 'warning'}>{stepStateLabel(selectedStep, process.principal)}</Tag>
                </div>
              </div>
              <Switch
                className="highrisk-switch"
                checked={selectedStep.highRisk}
                labelElement={<strong>高危实验步骤</strong>}
                innerLabel="普通"
                innerLabelChecked="高危"
                disabled={process.status === 'frozen'}
                onChange={(event) => updateStep('highRisk', event.currentTarget.checked)}
              />
              <p className="muted highrisk-hint">
                {selectedStep.highRisk
                  ? '该步骤不能一键确认：须由复核员填写姓名与依据首签，再由实验负责人独立确认；两人及研究员不得为同一人。首签后修改本步骤内容，首签立即作废并回到待复核。'
                  : '普通步骤由复核员逐条确认即可。开启高危后，将强制双人独立签署流程。'}
              </p>
              <FormGroup label="步骤名称" labelFor="step-title"><InputGroup id="step-title" fill value={selectedStep.title} onChange={(event) => updateStep('title', event.target.value)} /></FormGroup>
              <FormGroup label="操作目的" labelFor="step-purpose"><TextArea id="step-purpose" fill value={selectedStep.purpose} onChange={(event) => updateStep('purpose', event.target.value)} /></FormGroup>
              <div className="form-grid">
                <FormGroup label="材料" labelFor="materials"><TextArea id="materials" fill value={selectedStep.materials} onChange={(event) => updateStep('materials', event.target.value)} /></FormGroup>
                <FormGroup label="设备" labelFor="equipment"><TextArea id="equipment" fill value={selectedStep.equipment} onChange={(event) => updateStep('equipment', event.target.value)} /></FormGroup>
                <FormGroup label="用量 / 参数" labelFor="amount"><TextArea id="amount" fill value={selectedStep.amount} onChange={(event) => updateStep('amount', event.target.value)} /></FormGroup>
                <FormGroup label="预计时间（分钟）" labelFor="duration"><InputGroup id="duration" type="number" min={1} fill value={String(selectedStep.duration)} onChange={(event) => updateStep('duration', Number(event.target.value))} /></FormGroup>
              </div>
              <div className="form-grid two-column">
                <FormGroup label="危险项（逗号或换行分隔）" labelFor="hazards"><TextArea id="hazards" fill value={selectedStep.hazards.join('，')} onChange={(event) => updateStepList('hazards', event.target.value)} /></FormGroup>
                <FormGroup label="控制措施" labelFor="controls"><TextArea id="controls" fill value={selectedStep.controls} onChange={(event) => updateStep('controls', event.target.value)} /></FormGroup>
              </div>
              <FormGroup label="安全说明" labelFor="safety-note" helperText={hasMissingSafety(selectedStep) ? '存在危险项时，控制措施和安全说明均为必填。' : '安全说明已满足复核条件。'}>
                <TextArea id="safety-note" fill intent={hasMissingSafety(selectedStep) ? 'danger' : 'none'} value={selectedStep.safetyNote} onChange={(event) => updateStep('safetyNote', event.target.value)} />
              </FormGroup>
              <FormGroup label="预期结果" labelFor="expected"><TextArea id="expected" fill value={selectedStep.expectedResult} onChange={(event) => updateStep('expectedResult', event.target.value)} /></FormGroup>
            </Card>

            <Card elevation={Elevation.ONE} className="dependency-card">
              <div className="card-title"><div><span>DEPENDENCIES</span><h3>前置步骤</h3></div><Tag minimal>{selectedStep.dependencies.length} 个依赖</Tag></div>
              <p className="muted">当前步骤只有在所选前置步骤完成后才能进入执行队列。</p>
              <div className="dependency-grid">
                {process.steps.filter((step) => step.id !== selectedStep.id).map((step) => (
                  <Checkbox key={step.id} checked={selectedStep.dependencies.includes(step.id)} label={`${String(process.steps.indexOf(step) + 1).padStart(2, '0')} · ${step.title}`} onChange={(event) => toggleDependency(step.id, event.currentTarget.checked)} />
                ))}
              </div>
            </Card>
          </section>

          <aside className="inspector-panel">
            <Card elevation={Elevation.ONE} className="impact-card">
              <div className="card-title"><div><span>IMPACT ANALYSIS</span><h3>变更影响提醒</h3></div><Icon icon="path-search" size={18} /></div>
              {lastModifiedId ? (
                <>
                  <Callout intent={impactedSteps.length ? 'warning' : 'primary'} icon={impactedSteps.length ? 'warning-sign' : 'tick'}>
                    <strong>{impactedSteps.length ? `${impactedSteps.length} 个后续步骤受影响` : '未发现下游步骤'}</strong>
                    <p>{impactedSteps.length ? '请重新核对依赖、用量、危险项和已确认内容；高危步骤签名将作废。' : '当前修改没有影响其他步骤的安全条件。'}</p>
                  </Callout>
                  <div className="impact-list">
                    {impactedSteps.map((step) => (
                      <button key={step.id} onClick={() => setSelectedStepId(step.id)}>
                        <Icon icon={isStepConfirmed(step, process.principal) ? 'endorsed' : 'circle'} intent={isStepConfirmed(step, process.principal) ? 'success' : 'none'} size={13} />
                        <span><strong>{step.title}</strong><small>{isStepConfirmed(step, process.principal) ? '已确认内容，需重新复核' : `当前状态：${stepStateLabel(step, process.principal)}`}{step.highRisk ? ' · 高危双签将失效' : ''}</small></span>
                        <Icon icon="chevron-right" size={12} />
                      </button>
                    ))}
                  </div>
                </>
              ) : <p className="muted">编辑任一步骤后，这里会显示受影响的所有后续步骤和已确认内容。</p>}
            </Card>

            <Card elevation={Elevation.ONE} className="safety-card">
              <div className="card-title"><div><span>SAFETY GATE</span><h3>安全完整性</h3></div><Tag intent={missingSafetySteps.length ? 'danger' : 'success'} minimal>{missingSafetySteps.length ? `${missingSafetySteps.length} 项缺口` : '通过'}</Tag></div>
              {missingSafetySteps.length ? missingSafetySteps.map((step) => (
                <button className="safety-row" key={step.id} onClick={() => setSelectedStepId(step.id)}><Icon icon="warning-sign" intent="danger" size={14} /><span><strong>{step.title}</strong><small>危险项缺少控制措施或安全说明</small></span></button>
              )) : <p className="muted">所有存在危险项的步骤都已填写控制措施和安全说明。</p>}
            </Card>

            <Card elevation={Elevation.ONE} className="gate-card">
              <div className="card-title"><div><span>RELEASE GATE</span><h3>提交与冻结</h3></div></div>
              <div className="gate-row"><span>复核状态</span><strong>{confirmedCount}/{process.steps.length}</strong></div>
              <div className="gate-row"><span>高危双签</span><strong className={highRiskReadySteps.length === highRiskSteps.length ? '' : 'danger-text'}>{highRiskReadySteps.length}/{highRiskSteps.length}</strong></div>
              <div className="gate-row"><span>安全缺口</span><strong className={missingSafetySteps.length ? 'danger-text' : ''}>{missingSafetySteps.length}</strong></div>
              <div className="gate-row"><span>流程状态</span><strong>{processStatusLabel(process.status)}</strong></div>
              <Divider />
              {process.status === 'frozen' ? <Button fill intent="warning" icon="git-branch" text="从冻结版创建修订" onClick={startRevision} /> : <Button fill intent="primary" icon="send-to" text="提交复核" onClick={submitForReview} />}
            </Card>
          </aside>
        </main>
      )}

      {activeView === 'review' && (
        <main className="review-layout">
          <aside className="review-steps">
            <div className="panel-heading"><div><span>REVIEW QUEUE</span><h3>逐条复核</h3></div><Tag intent={pendingReviewCount ? 'warning' : 'success'}>{pendingReviewCount ? `${pendingReviewCount} 待处理` : '已完成'}</Tag></div>
            {process.steps.map((step, index) => {
              const ready = isStepConfirmed(step, process.principal);
              return (
                <button key={step.id} className={`${step.id === selectedStep?.id ? 'selected' : ''} ${ready ? 'confirmed' : step.status === 'returned' ? 'returned' : ''}`} onClick={() => setSelectedStepId(step.id)}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <div>
                    <strong>{step.title}{step.highRisk && <em className="highrisk-flag">高危</em>}</strong>
                    <small>{stepStateLabel(step, process.principal)}</small>
                  </div>
                  <Icon icon={ready ? 'tick-circle' : step.status === 'returned' ? 'undo' : step.highRisk ? 'shield' : 'circle'} intent={ready ? 'success' : step.highRisk ? 'warning' : 'none'} size={15} />
                </button>
              );
            })}
          </aside>
          <section className="review-main">
            {selectedStep && (
              <>
                <Card elevation={Elevation.ONE} className="review-summary">
                  <div className="card-title">
                    <div><span>SAFETY REVIEW</span><h3>{selectedStep.title}</h3></div>
                    <div className="step-title-tags">
                      {selectedStep.highRisk && <Tag minimal intent="danger" icon="shield">高危实验</Tag>}
                      <Tag intent={isStepConfirmed(selectedStep, process.principal) ? 'success' : selectedStep.status === 'returned' ? 'danger' : 'warning'}>{stepStateLabel(selectedStep, process.principal)}</Tag>
                    </div>
                  </div>
                  <div className="review-facts">
                    <div><span>预计时间</span><strong>{selectedStep.duration} 分钟</strong></div>
                    <div><span>材料与用量</span><strong>{selectedStep.materials} / {selectedStep.amount}</strong></div>
                    <div><span>危险项</span><strong>{selectedStep.hazards.join('、') || '无'}</strong></div>
                  </div>
                  <div className="review-section"><h4>控制措施</h4><p>{selectedStep.controls || '未填写'}</p></div>
                  <div className="review-section"><h4>安全说明</h4><p className={hasMissingSafety(selectedStep) ? 'danger-text' : ''}>{selectedStep.safetyNote || '未填写'}</p></div>
                  {selectedStep.highRisk && (
                    <div className="review-section sig-overview">
                      <h4>双签状态</h4>
                      <SignatureRecord title="复核员首签" signature={reviewerSig} missingText="待复核员填写姓名与依据" />
                      <SignatureRecord title="实验负责人会签" signature={leaderSig} missingText={reviewerSig ? '待实验负责人独立确认' : '首签完成后开放'} />
                    </div>
                  )}
                  {hasMissingSafety(selectedStep) && <Callout intent="danger" icon="warning-sign">当前步骤存在安全信息缺口，不能确认、签署或冻结版本。</Callout>}
                </Card>

                {selectedStep.highRisk && (
                  <Card elevation={Elevation.ONE} className="signature-card">
                    <div className="card-title">
                      <div><span>DUAL SIGNATURE</span><h3>高危步骤双人签署</h3></div>
                      <Tag minimal intent="danger" icon="shield">两人独立签字</Tag>
                    </div>
                    <Callout intent="none" icon="people" className="sig-rule">
                      研究员（{process.principal || '未填写'}）不得作为任一签署人；复核员首签后，实验负责人须以不同身份独立确认。同一人重复签署或与研究员、首签人同名，步骤将被退回。首签后内容变化，首签立即作废并回到待复核。
                    </Callout>

                    {signError && <Callout intent="danger" icon="disable" className="sig-error">{signError}</Callout>}

                    <div className={`sig-block ${reviewerSig ? 'signed' : ''}`}>
                      <header><Icon icon={reviewerSig ? 'tick-circle' : 'circle'} intent={reviewerSig ? 'success' : 'none'} size={15} /><strong>第一步 · 复核员首签</strong></header>
                      {reviewerSig ? (
                        <SignatureDetail signature={reviewerSig} />
                      ) : (
                        <>
                          <FormGroup label="复核员姓名" labelFor="reviewer-name">
                            <InputGroup id="reviewer-name" fill value={reviewerName} onValueChange={setReviewerName} placeholder="填写真实姓名，不得与研究员相同" />
                          </FormGroup>
                          <FormGroup label="复核依据" labelFor="reviewer-basis" helperText="请写明核对的风险点、规范条款或现场条件。">
                            <TextArea id="reviewer-basis" fill value={reviewerBasis} onChange={(event) => setReviewerBasis(event.target.value)} placeholder="例如：已核对放热控制、通风柜面风速与应急冷却措施，符合危化品作业规范…" />
                          </FormGroup>
                          <Button intent="primary" icon="edit" text="复核员首签（姓名 + 依据）" disabled={hasMissingSafety(selectedStep)} onClick={() => addSignature('reviewer')} />
                        </>
                      )}
                    </div>

                    <div className={`sig-block ${leaderSig ? 'signed' : ''} ${!reviewerSig ? 'locked' : ''}`}>
                      <header><Icon icon={leaderSig ? 'tick-circle' : reviewerSig ? 'circle' : 'lock'} intent={leaderSig ? 'success' : 'none'} size={15} /><strong>第二步 · 实验负责人独立确认</strong></header>
                      {leaderSig ? (
                        <SignatureDetail signature={leaderSig} />
                      ) : reviewerSig ? (
                        <>
                          <FormGroup label="实验负责人姓名" labelFor="leader-name">
                            <InputGroup id="leader-name" fill value={leaderName} onValueChange={setLeaderName} placeholder={`不得与研究员（${process.principal}）或首签人（${reviewerSig?.name}）相同`} />
                          </FormGroup>
                          <Checkbox
                            className="sig-ack"
                            checked={leaderAck}
                            onChange={(event) => setLeaderAck(event.currentTarget.checked)}
                            label="本人已独立复核该高危步骤的危险项、控制措施和应急条件，确认与首签无关联关系。"
                          />
                          <Button intent="success" icon="endorsed" text="实验负责人独立确认并签字" disabled={hasMissingSafety(selectedStep)} onClick={() => addSignature('leader')} />
                        </>
                      ) : (
                        <p className="muted">等待复核员完成首签后，实验负责人才可独立确认。</p>
                      )}
                    </div>

                    {selectedStep.voidedSignatures.length > 0 && (
                      <div className="sig-void-list">
                        <h4>作废 / 退回记录</h4>
                        {[...selectedStep.voidedSignatures].reverse().slice(0, 4).map((signature, index) => (
                          <div key={`${signature.signedAt}-${index}`} className="sig-void-row">
                            <Icon icon="history" size={13} intent="warning" />
                            <span>
                              <strong>{signature.role === 'reviewer' ? '复核员' : '实验负责人'} {signature.name}</strong>
                              签于 {formatFullDate(signature.signedAt)}，{formatFullDate(signature.voidedAt)} 作废：{signature.reason}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                )}

                <Card elevation={Elevation.ONE} className="comment-card">
                  <div className="card-title"><div><span>REVIEW COMMENTS</span><h3>复核批注</h3></div><Tag minimal>{selectedStep.comments.length} 条</Tag></div>
                  <div className="comment-compose">
                    <TextArea fill value={commentText} onChange={(event) => setCommentText(event.target.value)} placeholder="填写具体依据、风险或修改建议…" />
                    <Button intent="primary" icon="comment" text="添加批注" disabled={!commentText.trim()} onClick={addReviewComment} />
                  </div>
                  <div className="comment-list">
                    {selectedStep.comments.map((comment) => (
                      <article key={comment.id} className={comment.resolved ? 'resolved' : ''}>
                        <div className="comment-avatar">{comment.author.slice(0, 1)}</div>
                        <div><header><strong>{comment.author}</strong><span>{comment.role}</span><time>{formatDate(comment.createdAt)}</time></header><p>{comment.text}</p><Button minimal small text={comment.resolved ? '已解决' : '标记解决'} icon={comment.resolved ? 'tick' : 'circle'} onClick={() => resolveComment(comment.id)} /></div>
                      </article>
                    ))}
                    {!selectedStep.comments.length && <p className="muted">当前步骤尚未添加复核批注。</p>}
                  </div>
                </Card>
              </>
            )}
          </section>
          <aside className="review-actions">
            <Card elevation={Elevation.ONE}>
              <div className="card-title"><div><span>REVIEWER ACTION</span><h3>复核决定</h3></div><Icon icon="endorsed" size={18} /></div>
              {selectedStep?.highRisk ? (
                <Callout intent="warning" icon="shield" className="review-action-note">
                  高危实验步骤不支持一键确认。请在左侧双签面板完成：复核员填写姓名与依据首签，实验负责人再独立确认。
                </Callout>
              ) : (
                <Button fill large intent="success" icon="tick" text="逐条确认" disabled={!selectedStep || hasMissingSafety(selectedStep)} onClick={() => selectedStep && setStepStatus('confirmed')} />
              )}
              <Button fill large icon="undo" text="退回修改" intent="warning" disabled={!selectedStep} onClick={() => selectedStep && resetHighRiskSignatures('returned', '复核员退回修改，已有签署作废')} />
              <Button fill large minimal icon="refresh" text="恢复为待复核" disabled={!selectedStep} onClick={() => selectedStep && resetHighRiskSignatures('submitted', '恢复待复核，已有签署作废')} />
              <Divider />
              <div className="review-progress-list">
                {process.steps.map((step) => (
                  <div key={step.id}>
                    <span>{step.title}{step.highRisk && <em className="highrisk-flag">高危</em>}</span>
                    <Tag minimal intent={isStepConfirmed(step, process.principal) ? 'success' : step.status === 'returned' ? 'danger' : 'warning'}>{stepStateLabel(step, process.principal)}</Tag>
                  </div>
                ))}
              </div>
              <Button fill intent="primary" icon="lock" text="全部签署后冻结" onClick={freezeVersion} disabled={process.status === 'frozen' || !freezeReady} />
            </Card>
          </aside>
        </main>
      )}

      {activeView === 'compare' && (
        <main className="compare-layout">
          <Card elevation={Elevation.ONE} className="version-panel">
            <div className="card-title"><div><span>VERSION TIMELINE</span><h3>冻结版本</h3></div><Tag minimal>{process.versions.length} 个</Tag></div>
            <div className="version-timeline">
              {process.versions.map((version, index) => (
                <article key={version.id} className={index === process.versions.length - 1 ? 'latest' : ''}>
                  <span></span><div><b>{version.version}</b><strong>{version.label}</strong><p>{formatDate(version.createdAt)} · {version.steps.length} 个步骤 · {version.author}</p><small>{version.note}</small></div>
                </article>
              ))}
            </div>
          </Card>
          <Card elevation={Elevation.ONE} className="diff-panel">
            <div className="card-title"><div><span>VERSION DIFF</span><h3>流程差异比较</h3></div><div className="diff-selects">
              <HTMLSelect value={compareBaseId} onChange={(event) => setCompareBaseId(event.target.value)}>{process.versions.map((version) => <option key={version.id} value={version.id}>{version.version} · 基准</option>)}</HTMLSelect>
              <Icon icon="arrow-right" />
              <HTMLSelect value={compareTargetId} onChange={(event) => setCompareTargetId(event.target.value)}>{process.versions.map((version) => <option key={version.id} value={version.id}>{version.version} · 目标</option>)}</HTMLSelect>
            </div></div>
            <div className="diff-table">
              <div className="diff-head"><span>变更类型</span><span>步骤</span><span>具体内容</span></div>
              {versionDiff.map((diff) => <div className={`diff-row ${diff.kind}`} key={diff.id}><Tag minimal intent={diff.kind === 'added' ? 'success' : diff.kind === 'removed' ? 'danger' : 'primary'}>{diff.kind === 'added' ? '新增' : diff.kind === 'removed' ? '删除' : '修改'}</Tag><strong>{diff.title}</strong><p>{diff.detail}</p></div>)}
              {!versionDiff.length && <div className="empty-diff"><Icon icon="comparison" size={30} /><strong>两个版本没有差异</strong><p>请选择不同版本，或先冻结新的流程版本。</p></div>}
            </div>
          </Card>
          <Card elevation={Elevation.ONE} className="freeze-rules">
            <div className="card-title"><div><span>FREEZE RULES</span><h3>冻结检查</h3></div></div>
            <div className={confirmedCount === process.steps.length ? 'passed' : ''}><Icon icon={confirmedCount === process.steps.length ? 'tick-circle' : 'circle'} /><span><strong>所有步骤已确认</strong><small>{confirmedCount}/{process.steps.length}</small></span></div>
            <div className={highRiskReadySteps.length === highRiskSteps.length ? 'passed' : ''}>
              <Icon icon="shield" intent={highRiskReadySteps.length === highRiskSteps.length ? 'success' : 'warning'} />
              <span>
                <strong>高危步骤双人签署齐备</strong>
                <small>{highRiskReadySteps.length}/{highRiskSteps.length} 已双签</small>
                {highRiskSteps.map((step) => {
                  const reviewer = getReviewerSignature(step);
                  const leader = getLeaderSignature(step, process.principal);
                  const ready = !!reviewer && !!leader;
                  return (
                    <small key={step.id} className={ready ? 'sig-ok-line' : 'sig-gap-line'}>
                      · {step.title}：
                      {reviewer ? `复核员 ${reviewer.name} · ${formatFullDate(reviewer.signedAt)}` : '缺复核员首签（姓名+依据）'}
                      {' ／ '}
                      {leader
                        ? `实验负责人 ${leader.name} · ${formatFullDate(leader.signedAt)}`
                        : reviewer ? '缺实验负责人独立确认' : '缺负责人会签'}
                    </small>
                  );
                })}
              </span>
            </div>
            <div className={!missingSafetySteps.length ? 'passed' : ''}><Icon icon={!missingSafetySteps.length ? 'tick-circle' : 'circle'} /><span><strong>安全信息完整</strong><small>{missingSafetySteps.length} 个缺口</small></span></div>
            <div className={process.steps.every((step) => step.dependencies.every((id) => process.steps.some((item) => item.id === id))) ? 'passed' : ''}><Icon icon="git-merge" /><span><strong>依赖引用有效</strong><small>{process.steps.reduce((sum, step) => sum + step.dependencies.length, 0)} 条依赖</small></span></div>
            <Button fill intent="primary" icon="lock" text="冻结当前版本" onClick={freezeVersion} disabled={process.status === 'frozen' || !freezeReady} />
          </Card>
        </main>
      )}

      <footer className="app-footer">
        <span>所有实验数据仅保存在当前浏览器 localStorage；高危步骤须双人独立签署，签名随版本快照保留。</span>
        <span>Ctrl/Cmd + Z 撤销 · Ctrl/Cmd + Y 重做 · Ctrl/Cmd + S 保存</span>
      </footer>
    </div>
  );
}

function SignatureRecord({ title, signature, missingText }: { title: string; signature: Signature | null; missingText: string }) {
  return (
    <div className={`sig-overview-row ${signature ? 'ok' : 'missing'}`}>
      <Icon icon={signature ? 'tick-circle' : 'circle'} intent={signature ? 'success' : 'none'} size={14} />
      <span>
        <strong>{title}</strong>
        {signature
          ? <small>{signature.name} · {formatFullDate(signature.signedAt)} · {signature.basis}</small>
          : <small className="danger-text">{missingText}</small>}
      </span>
    </div>
  );
}

function SignatureDetail({ signature }: { signature: Signature }) {
  return (
    <div className="sig-detail">
      <div><span>签署人</span><strong>{signature.name}（{signature.role === 'reviewer' ? '安全复核员' : '实验负责人'}）</strong></div>
      <div><span>签署时间</span><strong>{formatFullDate(signature.signedAt)}</strong></div>
      <div><span>{signature.role === 'reviewer' ? '复核依据' : '确认说明'}</span><p>{signature.basis}</p></div>
    </div>
  );
}

function hasMissingSafety(step: ProcessStep): boolean {
  return step.hazards.length > 0 && (!step.controls.trim() || !step.safetyNote.trim());
}

function collectDownstream(steps: ProcessStep[], sourceId: string | null): string[] {
  if (!sourceId) return [];
  const result = new Set<string>();
  const visit = (id: string) => {
    steps.filter((step) => step.dependencies.includes(id)).forEach((step) => {
      if (result.has(step.id)) return;
      result.add(step.id);
      visit(step.id);
    });
  };
  visit(sourceId);
  return [...result];
}

function nextMinorVersion(value: string): string {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return '1.2.0';
  return `${match[1]}.${Number(match[2]) + 1}.0`;
}

function compareVersions(process: ExperimentProcess, baseId: string, targetId: string): DiffItem[] {
  const base = process.versions.find((version) => version.id === baseId);
  const target = process.versions.find((version) => version.id === targetId);
  if (!base || !target) return [];
  const diffs: DiffItem[] = [];
  const targetMap = new Map(target.steps.map((step) => [step.id, step]));
  const baseMap = new Map(base.steps.map((step) => [step.id, step]));
  base.steps.forEach((step) => {
    if (!targetMap.has(step.id)) diffs.push({ id: step.id, title: step.title, kind: 'removed', detail: '目标版本已删除该步骤。' });
  });
  target.steps.forEach((step) => {
    const before = baseMap.get(step.id);
    if (!before) {
      diffs.push({ id: step.id, title: step.title, kind: 'added', detail: `${step.duration} 分钟；危险项：${step.hazards.join('、') || '无'}${step.highRisk ? '；高危步骤（双签）' : ''}` });
      return;
    }
    const fields: string[] = [];
    if (before.title !== step.title) fields.push('名称');
    if (before.purpose !== step.purpose) fields.push('目的');
    if (before.materials !== step.materials || before.amount !== step.amount) fields.push('材料或用量');
    if (before.equipment !== step.equipment) fields.push('设备');
    if (before.duration !== step.duration) fields.push('预计时间');
    if (JSON.stringify(before.hazards) !== JSON.stringify(step.hazards)) fields.push('危险项');
    if (before.controls !== step.controls || before.safetyNote !== step.safetyNote) fields.push('安全控制');
    if (JSON.stringify(before.dependencies) !== JSON.stringify(step.dependencies)) fields.push('依赖关系');
    if (before.expectedResult !== step.expectedResult) fields.push('预期结果');
    if (before.highRisk !== step.highRisk) fields.push('高危标记');
    if (fields.length) diffs.push({ id: step.id, title: step.title, kind: 'changed', detail: `变化字段：${fields.join('、')}。` });
  });
  return diffs;
}

export default App;
