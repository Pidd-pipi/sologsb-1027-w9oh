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
  id: string;
  role: SignatureRole;
  signer: string;
  basis: string;
  signedAt: string;
  contentHash: string;
  voidedAt?: string;
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
  highRisk: boolean;
  signatures: Signature[];
  status: StepStatus;
  comments: ReviewComment[];
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
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

const SIGNATURE_FIELDS = [
  'title', 'purpose', 'materials', 'equipment', 'amount', 'duration',
  'hazards', 'controls', 'dependencies', 'safetyNote', 'expectedResult', 'highRisk'
] as const;

function signatureRoleLabel(role: SignatureRole): string {
  return role === 'reviewer' ? '复核员首签' : '实验负责人复签';
}

/** 参与签署的步骤内容指纹；仅内容字段变化会使既有签名作废，签名本身不影响哈希。 */
function stepContentHash(step: ProcessStep): string {
  const payload = SIGNATURE_FIELDS.map((field) => JSON.stringify((step as unknown as Record<string, unknown>)[field])).join('|');
  let hash = 5381;
  for (let i = 0; i < payload.length; i += 1) {
    hash = (hash * 33 + payload.charCodeAt(i)) >>> 0;
  }
  return `h${hash.toString(16)}`;
}

/** 有效签名：未作废、角色齐全，且签署时的内容与当前内容一致。 */
function getValidSignatures(step: ProcessStep): Signature[] {
  if (!step.highRisk) return [];
  const hash = stepContentHash(step);
  return step.signatures.filter((signature) => !signature.voidedAt && signature.contentHash === hash);
}

function getSignature(step: ProcessStep, role: SignatureRole): Signature | undefined {
  return getValidSignatures(step).find((signature) => signature.role === role);
}

function hasValidDoubleSign(step: ProcessStep): boolean {
  return step.highRisk && getValidSignatures(step).length >= 2;
}

/** 高危步骤才算“已确认”：双签完整且内容未被改动；普通步骤沿用原状态。 */
function isStepConfirmed(step: ProcessStep): boolean {
  return step.highRisk ? hasValidDoubleSign(step) : step.status === 'confirmed';
}

/** 签署校验：同一人重复签署、或与研究员/首签人同名一律拒绝（退回）。 */
function validateSigner(step: ProcessStep, role: SignatureRole, signer: string, researcher: string): string | null {
  const name = signer.trim();
  if (!name) return role === 'reviewer' ? '复核员姓名为必填项。' : '实验负责人姓名为必填项。';
  if (researcher.trim() && name === researcher.trim()) return `签署人不能与研究员「${researcher.trim()}」相同。`;
  const reviewer = getSignature(step, 'reviewer');
  if (role === 'reviewer' && reviewer) return '复核员已完成首签，不能由同一人重复签署。';
  if (role === 'leader') {
    if (!reviewer) return '须先由复核员完成首签，实验负责人才能独立确认。';
    if (name === reviewer.signer) return '实验负责人不能与首签复核员为同一人。';
    if (getSignature(step, 'leader')) return '实验负责人已完成复签，不能重复签署。';
  }
  return null;
}

/** 内容变更后既有有效签名全部作废；高危步骤回到待复核，重新双签后才能确认。 */
function voidSignaturesForChange(step: ProcessStep): boolean {
  const valid = getValidSignatures(step);
  if (!valid.length) return false;
  const now = new Date().toISOString();
  step.signatures = step.signatures.map((signature) =>
    signature.voidedAt ? signature : { ...signature, voidedAt: now }
  );
  step.status = 'submitted';
  return true;
}

function initialProcess(): ExperimentProcess {
  const baseSteps: ProcessStep[] = [
    {
      id: 'step-1', title: '核对试剂与实验区域', purpose: '确认所需物料、设备及区域状态符合实验方案。',
      materials: '无水乙醇、去离子水', equipment: '通风柜、防爆柜、标签打印机', amount: '乙醇 120 mL；去离子水 300 mL',
      duration: 15, hazards: ['易燃液体'], controls: '在通风柜内取用，远离点火源；使用接地金属容器。',
      dependencies: [], safetyNote: '操作人员需佩戴护目镜和防化手套。', expectedResult: '试剂标签、数量和有效期均核对无误。',
      highRisk: false, signatures: [],
      status: 'confirmed', comments: [
        { id: 'c-1', author: '李明', role: '研究员', text: '已核对批号和有效期，防爆柜温度记录正常。', createdAt: '2026-09-24T09:10:00+08:00', resolved: true }
      ]
    },
    {
      id: 'step-2', title: '搭建恒温循环装置', purpose: '连接循环浴与反应夹套，检查密封和温控。',
      materials: '无', equipment: '恒温循环浴、硅胶管、反应夹套、扎带', amount: '循环液 800 mL',
      duration: 25, hazards: ['烫伤', '管路脱落'], controls: '管路双端固定；升温前完成 5 分钟试压并设置独立超温断电。',
      dependencies: ['step-1'], safetyNote: '高温表面设置警示标识，循环浴周围保持干燥。', expectedResult: '30 分钟内温度稳定在 55 ± 0.5 ℃。',
      highRisk: false, signatures: [],
      status: 'confirmed', comments: [
        { id: 'c-2', author: '王颖', role: '安全复核员', text: '补充超温断电值，不能只依赖设备自带温控。', createdAt: '2026-09-24T10:05:00+08:00', resolved: true }
      ]
    },
    {
      id: 'step-3', title: '加入催化剂并启动反应', purpose: '按批次加入催化剂，记录起点并开始计时。',
      materials: '催化剂 A', equipment: '分析天平、加料漏斗、计时器', amount: '催化剂 A 2.50 ± 0.02 g',
      duration: 20, hazards: ['粉尘吸入', '放热反应'], controls: '在通风柜内称量，佩戴 N95 口罩；分三次少量加入并监测温度。',
      dependencies: ['step-2'], safetyNote: '反应温度超过 70 ℃ 时立即停止加料并启动冷却。', expectedResult: '温度缓慢升至 62–66 ℃，无明显冲料。',
      highRisk: true, signatures: [],
      status: 'submitted', comments: []
    },
    {
      id: 'step-4', title: '恒温反应与过程取样', purpose: '维持温度并定时取样观察反应转化。',
      materials: '样品瓶、惰性气体', equipment: '取样针、气相色谱、恒温循环浴', amount: '每点样品约 1 mL，共 6 点',
      duration: 90, hazards: ['高温液体', '挥发性气体'], controls: '取样前泄压；使用长针和防护屏；样品瓶及时封闭。',
      dependencies: ['step-3'], safetyNote: '取样时不得正对瓶口，样品瓶不得完全密封后加热。', expectedResult: '转化率达到 95% 以上且无异常副产物。',
      highRisk: true, signatures: [],
      status: 'submitted', comments: []
    },
    {
      id: 'step-5', title: '停止加热并冷却', purpose: '终止反应并将体系降至安全温度。',
      materials: '无', equipment: '循环浴、温度探头', amount: '降温目标 ≤ 30 ℃', duration: 35,
      hazards: ['烫伤', '残余反应'], controls: '先停止加料并维持搅拌，再以不超过 1 ℃/min 的速率降温。',
      dependencies: ['step-4'], safetyNote: '确认温度连续 5 分钟低于 30 ℃ 后才能拆除装置。', expectedResult: '体系温度稳定低于 30 ℃。',
      highRisk: false, signatures: [],
      status: 'draft', comments: []
    },
    {
      id: 'step-6', title: '废液分类与现场恢复', purpose: '按危险废物要求分类收集并恢复实验区域。',
      materials: '废液桶、吸附棉', equipment: '防化手套、护目镜、危废标签', amount: '按实际产生量记录', duration: 25,
      hazards: ['废液混装', '化学暴露'], controls: '有机废液单独收集，核对相容性后贴标签；泄漏吸附材料按危废处置。',
      dependencies: ['step-5'], safetyNote: '废液不得倒入下水道，现场恢复后完成双人确认。', expectedResult: '废液交接记录完整，台面无残留。',
      highRisk: false, signatures: [],
      status: 'draft', comments: []
    }
  ];

  // 演示：高危步骤 3 复核员已首签，等待实验负责人独立复签
  const pendingStep = baseSteps.find((step) => step.id === 'step-3');
  if (pendingStep) {
    pendingStep.signatures.push({
      id: 'sig-seed-reviewer-3', role: 'reviewer', signer: '王颖',
      basis: '已核对加料量、放热控制与超温停料阈值，措施可接受。',
      signedAt: '2026-09-28T10:20:00+08:00', contentHash: stepContentHash(pendingStep)
    });
  }

  /** 历史冻结版本：高危步骤保留当时的完整双签。 */
  const withFrozenSignatures = (step: ProcessStep, frozenAt: string): ProcessStep => {
    if (!step.highRisk) return { ...step, signatures: [] };
    return {
      ...step,
      signatures: [
        { id: uid('sig'), role: 'reviewer', signer: '王颖', basis: '冻结版本复核依据：危险项控制措施与安全说明完整。', signedAt: frozenAt, contentHash: stepContentHash(step) },
        { id: uid('sig'), role: 'leader', signer: '陈铎', basis: '独立复核确认，同意按该版本执行。', signedAt: frozenAt, contentHash: stepContentHash(step) }
      ]
    };
  };

  const firstVersion: VersionSnapshot = {
    id: 'version-1-0', label: '首版批准流程', version: '1.0.0', createdAt: '2026-09-20T14:30:00+08:00',
    note: '建立基础反应与取样步骤。', author: '王颖',
    steps: clone(baseSteps).slice(0, 4).map((step) => withFrozenSignatures({ ...step, status: 'confirmed', comments: [] }, '2026-09-20T14:20:00+08:00'))
  };
  const secondVersion: VersionSnapshot = {
    id: 'version-1-1', label: '补充冷却与废液步骤', version: '1.1.0', createdAt: '2026-09-24T15:10:00+08:00',
    note: '增加安全冷却、废液处置和现场恢复。', author: '王颖',
    steps: clone(baseSteps).map((step) => withFrozenSignatures({ ...step, status: 'confirmed', comments: [] }, '2026-09-24T15:00:00+08:00'))
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
    // 本地重开：补齐高危/签名字段；内容哈希对不上的历史签名按失效处理（保留痕迹）
    parsed.steps.forEach((step) => {
      if (typeof step.highRisk !== 'boolean') step.highRisk = false;
      if (!Array.isArray(step.signatures)) step.signatures = [];
      if (!Array.isArray(step.comments)) step.comments = [];
      const hash = stepContentHash(step);
      step.signatures = step.signatures.map((signature) =>
        signature.voidedAt || signature.contentHash === hash
          ? signature
          : { ...signature, voidedAt: signature.voidedAt ?? parsed.updatedAt ?? new Date(0).toISOString() }
      );
      if (step.highRisk && !hasValidDoubleSign(step) && step.status === 'confirmed') step.status = 'submitted';
    });
    parsed.versions.forEach((version) => {
      version.steps.forEach((step) => {
        if (typeof step.highRisk !== 'boolean') step.highRisk = false;
        if (!Array.isArray(step.signatures)) step.signatures = [];
        if (!Array.isArray(step.comments)) step.comments = [];
      });
    });
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

/** 列表与进度统一使用的状态文案：高危步骤双签齐全才算确认，否则按缺口提示。 */
function effectiveStatusLabel(step: ProcessStep): string {
  if (!step.highRisk) return statusLabel(step.status);
  if (hasValidDoubleSign(step)) return '双签已确认';
  if (step.status === 'returned') return '已退回';
  if (getValidSignatures(step).length === 1) return '待负责人复签';
  return '待双签复核';
}

function effectiveStatusIntent(step: ProcessStep): 'success' | 'danger' | 'warning' {
  if (isStepConfirmed(step)) return 'success';
  return step.status === 'returned' ? 'danger' : 'warning';
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

function App() {
  const [history, dispatch] = useReducer(historyReducer, undefined, () => ({ past: [], present: loadProcess(), future: [] }));
  const process = history.present;
  const [selectedStepId, setSelectedStepId] = useState(process.steps[0]?.id ?? '');
  const [activeView, setActiveView] = useState<ViewId>('editor');
  const [lastModifiedId, setLastModifiedId] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [reviewerName, setReviewerName] = useState(CURRENT_AUTHOR);
  const [reviewerBasis, setReviewerBasis] = useState('');
  const [leaderName, setLeaderName] = useState('');
  const [leaderBasis, setLeaderBasis] = useState('');
  const [signError, setSignError] = useState<string | null>(null);
  const [savedLabel, setSavedLabel] = useState('本地数据已载入');
  const [online, setOnline] = useState(true);
  const [compareBaseId, setCompareBaseId] = useState(process.versions[0]?.id ?? '');
  const [compareTargetId, setCompareTargetId] = useState(process.versions.at(-1)?.id ?? '');
  const initialSaveSkipped = useRef(false);

  const selectedStep = process.steps.find((step) => step.id === selectedStepId) ?? process.steps[0];
  const downstreamIds = useMemo(() => collectDownstream(process.steps, lastModifiedId), [process.steps, lastModifiedId]);
  const impactedSteps = process.steps.filter((step) => downstreamIds.includes(step.id));
  const missingSafetySteps = process.steps.filter(hasMissingSafety);
  const highRiskSteps = process.steps.filter((step) => step.highRisk);
  const signatureGapSteps = highRiskSteps.filter((step) => !hasValidDoubleSign(step));
  const pendingReviewCount = process.steps.filter((step) => step.status === 'submitted' || step.status === 'returned').length;
  const confirmedCount = process.steps.filter(isStepConfirmed).length;
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
      if (!step) return;
      const isContentField = (SIGNATURE_FIELDS as readonly string[]).includes(field);
      // 先作废与当前内容绑定的有效签名，再写入新内容，避免新内容被旧哈希"重新确认"
      if (isContentField) voidSignaturesForChange(step);
      (step as unknown as Record<string, unknown>)[field] = value;
      // 高危步骤无论开关如何变化，都需要重新双签
      if (field === 'highRisk' && value === true) {
        step.signatures = step.signatures.map((signature) =>
          signature.voidedAt ? signature : { ...signature, voidedAt: new Date().toISOString() }
        );
        if (step.status === 'confirmed') step.status = 'submitted';
      }
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
        safetyNote: '', expectedResult: '', highRisk: false, signatures: [], status: 'draft', comments: []
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
    copy.signatures = [];
    copy.dependencies = [...copy.dependencies];
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
      // 依赖引用被删除属于内容变化，受影响步骤的既有签名一并作废
      draft.steps.forEach((step) => {
        if (step.dependencies.includes(id)) {
          step.dependencies = step.dependencies.filter((dependency) => dependency !== id);
          voidSignaturesForChange(step);
        }
      });
      draft.steps = draft.steps.filter((step) => step.id !== id);
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
        if (step.status !== 'confirmed') step.status = 'submitted';
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
    const id = selectedStep.id;
    commitProcess((draft) => {
      const step = draft.steps.find((item) => item.id === id);
      if (!step) return;
      // 高危步骤不允许一键确认；退回或重置为待复核时，既有签名全部作废，需要重新双签
      if (step.highRisk && status !== 'confirmed') {
        const now = new Date().toISOString();
        step.signatures = step.signatures.map((signature) =>
          signature.voidedAt ? signature : { ...signature, voidedAt: now }
        );
      }
      step.status = step.highRisk && status === 'confirmed' ? step.status : status;
    });
    setLastModifiedId(status === 'returned' ? id : null);
    if (status === 'returned') setSavedLabel(selectedStep.highRisk ? '高危步骤已退回，原签名作废，需重新双签' : '步骤已退回修改');
  };

  const resolveComment = (commentId: string): void => {
    if (!selectedStep) return;
    const stepId = selectedStep.id;
    commitProcess((draft) => {
      const comment = draft.steps.find((step) => step.id === stepId)?.comments.find((item) => item.id === commentId);
      if (comment) comment.resolved = !comment.resolved;
    });
  };

  /** 高危步骤双人签署：校验通过才落签名；同一人/与研究员或首签人同名则退回。 */
  const signStep = (role: SignatureRole): void => {
    if (!selectedStep || !selectedStep.highRisk) return;
    const id = selectedStep.id;
    const signer = role === 'reviewer' ? reviewerName : leaderName;
    const basis = (role === 'reviewer' ? reviewerBasis : leaderBasis).trim();
    if (!basis) {
      setSignError(role === 'reviewer' ? '请填写复核依据后再签署。' : '请填写独立确认依据后再签署。');
      return;
    }
    if (hasMissingSafety(selectedStep)) {
      setSignError('存在安全信息缺口，不能签署，请先补齐控制措施与安全说明。');
      return;
    }
    const error = validateSigner(selectedStep, role, signer, process.principal);
    if (error) {
      commitProcess((draft) => {
        const step = draft.steps.find((item) => item.id === id);
        if (step) step.status = 'returned';
      });
      setSignError(`${error} 该高危步骤已退回修改。`);
      setLastModifiedId(id);
      setSavedLabel('签署未通过：高危步骤已退回');
      return;
    }
    commitProcess((draft) => {
      const step = draft.steps.find((item) => item.id === id);
      if (!step) return;
      step.signatures.push({
        id: uid('sig'), role, signer: signer.trim(), basis,
        signedAt: new Date().toISOString(), contentHash: stepContentHash(step)
      });
      step.status = hasValidDoubleSign(step) ? 'confirmed' : 'submitted';
    });
    setSignError(null);
    if (role === 'reviewer') {
      setReviewerBasis('');
      setSavedLabel('复核员首签完成，等待实验负责人复签');
    } else {
      setLeaderName('');
      setLeaderBasis('');
      setSavedLabel('双签完成，高危步骤已确认');
    }
  };

  const freezeVersion = (): void => {
    if (process.status === 'frozen') return;
    if (process.steps.some((step) => !isStepConfirmed(step)) || missingSafetySteps.length || signatureGapSteps.length) {
      setSavedLabel(signatureGapSteps.length ? `冻结条件未满足：${signatureGapSteps.length} 个高危步骤双签不齐` : '冻结条件未满足');
      return;
    }
    const nextNumber = nextMinorVersion(process.version);
    const previousVersionId = process.versions.at(-1)?.id ?? '';
    const frozenVersionId = uid('version');
    commitProcess((draft) => {
      const doubleSigned = draft.steps.filter((step) => step.highRisk).length;
      draft.versions.push({
        id: frozenVersionId, label: '复核通过冻结版', version: nextNumber,
        createdAt: new Date().toISOString(),
        note: `${draft.steps.length} 个步骤全部确认，安全控制完整；其中 ${doubleSigned} 个高危步骤保留双人有效签名。`,
        author: CURRENT_AUTHOR, steps: clone(draft.steps)
      });
      draft.version = nextNumber;
      draft.status = 'frozen';
      draft.frozenAt = new Date().toISOString();
    });
    setSavedLabel(`版本 ${nextNumber} 已冻结，双签记录随快照保留`);
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
        step.signatures = [];
      });
    });
    setActiveView('editor');
    setSavedLabel('已从冻结版本创建修订稿，全部签名需重新完成');
  };

  const addVersionSnapshot = (): void => {
    commitProcess((draft) => {
      draft.versions.push({
        id: uid('version'), label: '工作版本快照', version: draft.version.replace('-draft', ''),
        createdAt: new Date().toISOString(), note: '保存当前步骤与复核状态。',
        author: CURRENT_AUTHOR, steps: clone(draft.steps)
      });
    });
    setSavedLabel('已保存工作版本快照');
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <div className="brand-icon"><Icon icon="lab-test" size={23} /></div>
          <div><h1>实验流程安全复核台</h1><p>步骤影响分析 · 逐条复核 · 冻结版本</p></div>
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
          <div><span>负责人</span><strong>{process.principal}</strong></div>
          <div><span>实验区域</span><strong>{process.lab}</strong></div>
          <div><span>当前版本</span><strong>{process.version}</strong></div>
        </div>
        <div className="banner-progress">
          <div><span>复核进度</span><strong>{confirmedCount}/{process.steps.length}</strong></div>
          <ProgressBar value={reviewProgress / 100} intent={reviewProgress === 100 ? 'success' : 'primary'} stripes={reviewProgress < 100} />
          <small>{pendingReviewCount ? `${pendingReviewCount} 条待处理` : '所有步骤已处理'} · {missingSafetySteps.length} 条安全缺口</small>
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
                  <span className={`step-number ${isStepConfirmed(step) ? 'confirmed' : step.status === 'returned' ? 'returned' : ''}`}>{String(index + 1).padStart(2, '0')}</span>
                  <span className="step-copy">
                    <strong>
                      {step.highRisk && <Icon icon="shield" size={11} intent="danger" className="step-risk-icon" title="高危步骤：需双人签署" />}
                      {step.title}
                    </strong>
                    <small>{step.duration} 分钟 · {effectiveStatusLabel(step)}</small>
                  </span>
                  {hasMissingSafety(step) && <Icon icon="warning-sign" intent="danger" size={13} />}
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
                <FormGroup label="负责人" labelFor="principal"><InputGroup id="principal" fill value={process.principal} onChange={(event) => updateProcessField('principal', event.target.value)} /></FormGroup>
                <FormGroup label="实验区域" labelFor="lab"><InputGroup id="lab" fill value={process.lab} onChange={(event) => updateProcessField('lab', event.target.value)} /></FormGroup>
              </div>
              <FormGroup label="实验目标" labelFor="objective"><TextArea id="objective" fill value={process.objective} onChange={(event) => updateProcessField('objective', event.target.value)} /></FormGroup>
            </Card>

            <Card elevation={Elevation.ONE} className="step-editor-card">
              <div className="card-title">
                <div><span>STEP {String(process.steps.indexOf(selectedStep) + 1).padStart(2, '0')}</span><h3>{selectedStep.title}</h3></div>
                <Tag minimal intent={effectiveStatusIntent(selectedStep)}>{effectiveStatusLabel(selectedStep)}</Tag>
              </div>
              <FormGroup label="步骤名称" labelFor="step-title"><InputGroup id="step-title" fill value={selectedStep.title} onChange={(event) => updateStep('title', event.target.value)} /></FormGroup>
              <div className="risk-toggle-row">
                <Checkbox
                  checked={selectedStep.highRisk}
                  onChange={(event) => updateStep('highRisk', event.currentTarget.checked)}
                  label="高危实验步骤（须复核员与实验负责人双人独立签署后才能确认、冻结）"
                />
                {selectedStep.highRisk && <SignatureBadges step={selectedStep} researcher={process.principal} />}
              </div>
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
                    <p>{impactedSteps.length ? '请重新核对依赖、用量、危险项和已确认内容。' : '当前修改没有影响其他步骤的安全条件。'}</p>
                  </Callout>
                  <div className="impact-list">
                    {impactedSteps.map((step) => (
                      <button key={step.id} onClick={() => setSelectedStepId(step.id)}>
                        <Icon icon={isStepConfirmed(step) ? 'endorsed' : 'circle'} intent={isStepConfirmed(step) ? 'success' : 'none'} size={13} />
                        <span><strong>{step.title}</strong><small>{isStepConfirmed(step) ? (step.highRisk ? '已双签确认，内容修改将作废签名' : '已确认内容，需重新复核') : `当前状态：${effectiveStatusLabel(step)}`}</small></span>
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
              <div className="gate-row"><span>高危双签缺口</span><strong className={signatureGapSteps.length ? 'danger-text' : ''}>{signatureGapSteps.length}/{highRiskSteps.length}</strong></div>
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
            {process.steps.map((step, index) => (
              <button key={step.id} className={`${step.id === selectedStep.id ? 'selected' : ''} ${isStepConfirmed(step) ? 'confirmed' : step.status === 'returned' ? 'returned' : ''}`} onClick={() => setSelectedStepId(step.id)}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <strong>
                    {step.highRisk && <Icon icon="shield" size={11} intent="danger" className="step-risk-icon" />}
                    {step.title}
                  </strong>
                  <small>{effectiveStatusLabel(step)}</small>
                </div>
                <Icon icon={isStepConfirmed(step) ? 'tick-circle' : step.status === 'returned' ? 'undo' : (step.highRisk ? 'shield' : 'circle')} intent={isStepConfirmed(step) ? 'success' : step.highRisk ? 'danger' : 'none'} size={15} />
              </button>
            ))}
          </aside>
          <section className="review-main">
            {selectedStep && (
              <>
                <Card elevation={Elevation.ONE} className="review-summary">
                  <div className="card-title"><div><span>SAFETY REVIEW</span><h3>{selectedStep.title}</h3></div><Tag intent={effectiveStatusIntent(selectedStep)}>{effectiveStatusLabel(selectedStep)}</Tag></div>
                  {selectedStep.highRisk && (
                    <Callout intent={hasValidDoubleSign(selectedStep) ? 'success' : 'danger'} icon="shield" className="high-risk-callout">
                      <strong>高危实验步骤 · 双人独立签署</strong>
                      <p>复核员填写姓名与依据完成首签后，实验负责人须再次独立确认；同一人重复签署或与研究员同名将被退回。研究员：{process.principal}。</p>
                    </Callout>
                  )}
                  <div className="review-facts">
                    <div><span>预计时间</span><strong>{selectedStep.duration} 分钟</strong></div>
                    <div><span>材料与用量</span><strong>{selectedStep.materials} / {selectedStep.amount}</strong></div>
                    <div><span>危险项</span><strong>{selectedStep.hazards.join('、') || '无'}</strong></div>
                  </div>
                  <div className="review-section"><h4>控制措施</h4><p>{selectedStep.controls || '未填写'}</p></div>
                  <div className="review-section"><h4>安全说明</h4><p className={hasMissingSafety(selectedStep) ? 'danger-text' : ''}>{selectedStep.safetyNote || '未填写'}</p></div>
                  {hasMissingSafety(selectedStep) && <Callout intent="danger" icon="warning-sign">当前步骤存在安全信息缺口，不能确认或冻结版本。</Callout>}
                </Card>
                {selectedStep.highRisk && (
                  <SignatureCard
                    step={selectedStep}
                    researcher={process.principal}
                    reviewerName={reviewerName}
                    reviewerBasis={reviewerBasis}
                    leaderName={leaderName}
                    leaderBasis={leaderBasis}
                    signError={signError}
                    onReviewerName={setReviewerName}
                    onReviewerBasis={setReviewerBasis}
                    onLeaderName={setLeaderName}
                    onLeaderBasis={setLeaderBasis}
                    onSign={signStep}
                  />
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
                <>
                  <p className="muted">该步骤为高危实验，复核员一键确认已禁用。请在左侧「双人签署」卡片中完成复核员首签与实验负责人复签。</p>
                  <SignatureBadges step={selectedStep} researcher={process.principal} compact />
                  <Button fill large icon="undo" text="退回修改（作废签名）" intent="warning" onClick={() => setStepStatus('returned')} />
                  <Button fill large minimal icon="refresh" text="重置为待复核（作废签名）" onClick={() => setStepStatus('submitted')} />
                </>
              ) : (
                <>
                  <p className="muted">确认后若修改该步骤，受影响的下游步骤会在编辑页重新提示。</p>
                  <Button fill large intent="success" icon="tick" text="逐条确认" disabled={hasMissingSafety(selectedStep)} onClick={() => setStepStatus('confirmed')} />
                  <Button fill large icon="undo" text="退回修改" intent="warning" onClick={() => setStepStatus('returned')} />
                  <Button fill large minimal icon="refresh" text="恢复为待复核" onClick={() => setStepStatus('submitted')} />
                </>
              )}
              <Divider />
              <div className="review-progress-list">
                {process.steps.map((step) => (
                  <div key={step.id}>
                    <span>
                      {step.highRisk && <Icon icon="shield" size={11} intent="danger" className="step-risk-icon" />}
                      {step.title}
                    </span>
                    <Tag minimal intent={effectiveStatusIntent(step)}>{effectiveStatusLabel(step)}</Tag>
                  </div>
                ))}
              </div>
              <Button fill intent="primary" icon="lock" text="全部确认后冻结" onClick={freezeVersion} disabled={process.status === 'frozen' || confirmedCount !== process.steps.length || missingSafetySteps.length > 0 || signatureGapSteps.length > 0} />
            </Card>
          </aside>
        </main>
      )}

      {activeView === 'compare' && (
        <main className="compare-layout">
          <Card elevation={Elevation.ONE} className="version-panel">
            <div className="card-title"><div><span>VERSION TIMELINE</span><h3>冻结版本</h3></div><Tag minimal>{process.versions.length} 个</Tag></div>
            <div className="version-timeline">
              {process.versions.map((version, index) => {
                const highRiskTotal = version.steps.filter((step) => step.highRisk).length;
                const doubleSigned = version.steps.filter(hasValidDoubleSign).length;
                return (
                  <article key={version.id} className={index === process.versions.length - 1 ? 'latest' : ''}>
                    <span></span>
                    <div>
                      <b>{version.version}</b><strong>{version.label}</strong>
                      <p>{formatDate(version.createdAt)} · {version.steps.length} 个步骤 · {version.author}</p>
                      {highRiskTotal > 0 && (
                        <p className={doubleSigned === highRiskTotal ? 'snapshot-sign-ok' : 'snapshot-sign-missing'}>
                          <Icon icon="shield" size={10} /> 高危双签快照：{doubleSigned}/{highRiskTotal} 个步骤签齐并随版本保留
                        </p>
                      )}
                      <small>{version.note}</small>
                    </div>
                  </article>
                );
              })}
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
            <div className={!signatureGapSteps.length ? 'passed' : ''}><Icon icon={!signatureGapSteps.length ? 'shield' : 'warning-sign'} intent={signatureGapSteps.length ? 'danger' : 'none'} /><span><strong>高危步骤双人签署齐全</strong><small>{highRiskSteps.length - signatureGapSteps.length}/{highRiskSteps.length} 已签齐</small></span></div>
            {signatureGapSteps.length > 0 && (
              <div className="signature-gap-list">
                {signatureGapSteps.map((step) => {
                  const reviewer = getSignature(step, 'reviewer');
                  const leader = getSignature(step, 'leader');
                  return (
                    <div key={step.id} className="signature-gap-row">
                      <strong><Icon icon="shield" size={11} intent="danger" />{step.title}</strong>
                      <small>{reviewer ? `首签：${reviewer.signer} · ${formatDate(reviewer.signedAt)}` : '缺：复核员首签'}</small>
                      <small className={leader ? '' : 'danger-text'}>{leader ? `复签：${leader.signer} · ${formatDate(leader.signedAt)}` : '缺：实验负责人复签'}</small>
                    </div>
                  );
                })}
              </div>
            )}
            <div className={!missingSafetySteps.length ? 'passed' : ''}><Icon icon={!missingSafetySteps.length ? 'tick-circle' : 'circle'} /><span><strong>安全信息完整</strong><small>{missingSafetySteps.length} 个缺口</small></span></div>
            <div className={process.steps.every((step) => step.dependencies.every((id) => process.steps.some((item) => item.id === id))) ? 'passed' : ''}><Icon icon="git-merge" /><span><strong>依赖引用有效</strong><small>{process.steps.reduce((sum, step) => sum + step.dependencies.length, 0)} 条依赖</small></span></div>
            <Button fill intent="primary" icon="lock" text="冻结当前版本" onClick={freezeVersion} disabled={process.status === 'frozen' || confirmedCount !== process.steps.length || missingSafetySteps.length > 0 || signatureGapSteps.length > 0} />
          </Card>
        </main>
      )}

      <footer className="app-footer">
        <span>所有实验数据仅保存在当前浏览器 localStorage。</span>
        <span>Ctrl/Cmd + Z 撤销 · Ctrl/Cmd + Y 重做 · Ctrl/Cmd + S 保存</span>
      </footer>
    </div>
  );
}

function hasMissingSafety(step: ProcessStep): boolean {
  return step.hazards.length > 0 && (!step.controls.trim() || !step.safetyNote.trim());
}

interface SignatureCardProps {
  step: ProcessStep;
  researcher: string;
  reviewerName: string;
  reviewerBasis: string;
  leaderName: string;
  leaderBasis: string;
  signError: string | null;
  onReviewerName: (value: string) => void;
  onReviewerBasis: (value: string) => void;
  onLeaderName: (value: string) => void;
  onLeaderBasis: (value: string) => void;
  onSign: (role: SignatureRole) => void;
}

function SignatureCard(props: SignatureCardProps) {
  const { step, researcher, signError } = props;
  const reviewer = getSignature(step, 'reviewer');
  const leader = getSignature(step, 'leader');
  const voided = step.signatures.filter((signature) => signature.voidedAt);
  const missingSafety = hasMissingSafety(step);
  return (
    <Card elevation={Elevation.ONE} className="signature-card">
      <div className="card-title">
        <div><span>DUAL SIGN-OFF</span><h3>高危步骤双人签署</h3></div>
        <Tag intent={hasValidDoubleSign(step) ? 'success' : 'danger'} minimal icon="shield">
          {hasValidDoubleSign(step) ? '双签齐全' : `缺口 ${2 - getValidSignatures(step).length} 项`}
        </Tag>
      </div>

      <div className="signature-slots">
        <SignatureSlot role="reviewer" signature={reviewer} />
        <SignatureSlot role="leader" signature={leader} />
      </div>

      {missingSafety && <Callout intent="danger" icon="warning-sign" className="signature-callout">安全信息存在缺口，补齐后才能签署。</Callout>}
      {signError && <Callout intent="danger" icon="cross" className="signature-callout">{signError}</Callout>}

      {!reviewer ? (
        <div className="signature-form">
          <h4><Icon icon="person" size={13} /> 复核员首签</h4>
          <p className="muted">研究员（不可与签署人相同）：<strong>{researcher || '未填写'}</strong></p>
          <FormGroup label="复核员姓名" labelFor="reviewer-name">
            <InputGroup id="reviewer-name" fill value={props.reviewerName} onChange={(event) => props.onReviewerName(event.target.value)} placeholder="输入复核员真实姓名" />
          </FormGroup>
          <FormGroup label="复核依据" labelFor="reviewer-basis">
            <TextArea id="reviewer-basis" fill value={props.reviewerBasis} onChange={(event) => props.onReviewerBasis(event.target.value)} placeholder="引用规范条款、核查的危险项与控制措施等依据…" />
          </FormGroup>
          <Button intent="primary" icon="hand" text="复核员签字确认" disabled={missingSafety} onClick={() => props.onSign('reviewer')} />
        </div>
      ) : !leader ? (
        <div className="signature-form">
          <h4><Icon icon="people" size={13} /> 实验负责人独立复签</h4>
          <p className="muted">复签人不能是研究员（{researcher || '未填写'}），也不能与首签人（{reviewer.signer}）为同一人。</p>
          <FormGroup label="实验负责人姓名" labelFor="leader-name">
            <InputGroup id="leader-name" fill value={props.leaderName} onChange={(event) => props.onLeaderName(event.target.value)} placeholder="输入实验负责人姓名" />
          </FormGroup>
          <FormGroup label="独立确认依据" labelFor="leader-basis">
            <TextArea id="leader-basis" fill value={props.leaderBasis} onChange={(event) => props.onLeaderBasis(event.target.value)} placeholder="负责人独立核查结论与依据…" />
          </FormGroup>
          <Button intent="danger" icon="hand" text="实验负责人独立签字确认" disabled={missingSafety} onClick={() => props.onSign('leader')} />
        </div>
      ) : (
        <Callout intent="success" icon="shield" className="signature-callout">
          <strong>两位签署人已签齐，高危步骤冻结前保持有效。</strong>
          <p>签署后若步骤内容被修改，两个签名将立即作废并回到待复核，须重新双签。</p>
        </Callout>
      )}

      {voided.length > 0 && (
        <div className="voided-signatures">
          <h5>作废签名记录（{voided.length}）</h5>
          {voided.map((signature) => (
            <div key={signature.id} className="voided-row">
              <Icon icon="cross-circle" intent="danger" size={13} />
              <span>{signatureRoleLabel(signature.role)}：{signature.signer} · 签于 {formatDate(signature.signedAt)} · {formatDate(signature.voidedAt!)} 因内容变化或退回作废</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function SignatureSlot({ role, signature }: { role: SignatureRole; signature?: Signature }) {
  return (
    <div className={`signature-slot ${signature ? 'filled' : 'empty'}`}>
      <header>
        <Icon icon={signature ? 'endorsed' : 'circle'} intent={signature ? 'success' : 'none'} size={15} />
        <strong>{signatureRoleLabel(role)}</strong>
        <Tag minimal intent={signature ? 'success' : 'warning'}>{signature ? '已签' : '缺口'}</Tag>
      </header>
      {signature ? (
        <>
          <p className="signer-name">{signature.signer}</p>
          <p className="signer-basis">{signature.basis}</p>
          <time>{formatDate(signature.signedAt)}</time>
        </>
      ) : (
        <p className="muted">{role === 'reviewer' ? '等待复核员填写姓名与依据' : '等待实验负责人独立确认'}</p>
      )}
    </div>
  );
}

function SignatureBadges({ step, researcher, compact = false }: { step: ProcessStep; researcher: string; compact?: boolean }) {
  if (!step.highRisk) return null;
  const reviewer = getSignature(step, 'reviewer');
  const leader = getSignature(step, 'leader');
  return (
    <div className={`signature-badges ${compact ? 'compact' : ''}`}>
      <span className={reviewer ? 'ok' : 'missing'}>
        <Icon icon={reviewer ? 'endorsed' : 'circle'} size={12} />
        复核员：{reviewer ? `${reviewer.signer} · ${formatDate(reviewer.signedAt)}` : '待首签'}
      </span>
      <span className={leader ? 'ok' : 'missing'}>
        <Icon icon={leader ? 'endorsed' : 'circle'} size={12} />
        负责人：{leader ? `${leader.signer} · ${formatDate(leader.signedAt)}` : '待复签'}
      </span>
      {!compact && <small>研究员：{researcher || '未填写'}（两个签署人均不得与之同名）</small>}
    </div>
  );
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
      diffs.push({ id: step.id, title: step.title, kind: 'added', detail: `${step.duration} 分钟；危险项：${step.hazards.join('、') || '无'}` });
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
    if (Boolean(before.highRisk) !== Boolean(step.highRisk)) fields.push('高危标记');
    const signSummary = (target: ProcessStep): string =>
      target.highRisk
        ? getValidSignatures(target).map((signature) => `${signatureRoleLabel(signature.role)}：${signature.signer}`).join('；') || '无有效签名'
        : '非高危';
    const beforeSign = signSummary(before);
    const afterSign = signSummary(step);
    if (beforeSign !== afterSign) fields.push(`高危双签（${beforeSign} → ${afterSign}）`);
    if (fields.length) diffs.push({ id: step.id, title: step.title, kind: 'changed', detail: `变化字段：${fields.join('、')}。` });
  });
  return diffs;
}

export default App;
