import { create } from 'zustand';
import type {
  KeyAlgorithmDescriptor,
  KeyTestVector,
  KeyTrialResult,
  ServiceDef,
  UdsLibrary,
  UnlockResult,
} from '@doip/shared';

/**
 * 服务库 / Key 算法 store（T12 + T14）。
 *
 * - 后端是唯一真源：前端只在编辑期间持有"草稿"，保存后以 `library.snapshot` 回灌为准。
 * - `library.rejected` 带来的 issues 原样展示（含行号），绝不静默。
 */

export type LibraryValidationIssue = {
  path: string;
  line: number;
  column: number;
  messageZh: string;
  severity: 'error' | 'warn';
};

export type LibraryEditorTab = 'services' | 'subFunctions' | 'dids' | 'nrc' | 'aliases' | 'keyAlgorithms';

export interface LibraryState {
  library: UdsLibrary | null;
  /** 编辑器打开状态（F 区） */
  editorOpen: boolean;
  editorTab: LibraryEditorTab;
  issues: LibraryValidationIssue[];
  /** 草稿：非 null 表示有未保存的修改 */
  draft: UdsLibrary | null;

  algorithms: KeyAlgorithmDescriptor[];
  vectors: KeyTestVector[];
  /**
   * ★后端指定的"默认应选"算法 id（仿真 = 逐字节异或 0x5A；真实 = 已验证的移植算法）。
   * 前端不得自作主张取 `algorithms[0]`——那是占位算法，一键解锁开箱必吃 NRC 0x35。
   */
  recommendedId: string | null;
  /**
   * ★用户**手动**选中的算法 id（QA 终验边界：先开安全页手动选、后启仿真触发重拉清单，
   *   recommendedId 变化绝不能悄悄覆盖用户的选择）。
   *   放在 store 里而不是组件局部 state —— 否则切走页签再回来，用户的选择就丢了。
   */
  pickedAlgorithmId: string | null;
  trial: KeyTrialResult | null;
  unlock: UnlockResult | null;

  setLibrary(library: UdsLibrary): void;
  openEditor(tab?: LibraryEditorTab): void;
  closeEditor(): void;
  setEditorTab(tab: LibraryEditorTab): void;
  setIssues(issues: LibraryValidationIssue[]): void;
  setDraft(draft: UdsLibrary | null): void;
  setAlgorithms(
    algorithms: KeyAlgorithmDescriptor[],
    vectors: KeyTestVector[],
    recommendedId?: string | null,
  ): void;
  /** 用户手动选算法；传 null = 交还给后端推荐 */
  pickAlgorithm(id: string | null): void;
  setTrial(trial: KeyTrialResult | null): void;
  setUnlock(result: UnlockResult | null): void;
}

/** 挑选当前等级可用的算法（占位排最后、verified 排前） */
export function algorithmsForLevel(
  algorithms: KeyAlgorithmDescriptor[],
  level: number,
): KeyAlgorithmDescriptor[] {
  const hit = algorithms.filter((a) => a.appliesToLevels.length === 0 || a.appliesToLevels.includes(level));
  const list = hit.length > 0 ? hit : algorithms;
  return [...list].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

function rank(a: KeyAlgorithmDescriptor): number {
  if (a.origin === 'placeholder') return 2;
  if (!a.verified) return 1;
  return 0;
}

/**
 * ★默认算法的选择口径（QA 终验缺陷 3 + 边界补充），顺序即优先级：
 *  ① 用户手动选过 → **永远**尊重用户（后端重拉清单换了 recommendedId 也不覆盖）；
 *  ② 后端推荐（仿真在跑 = 仿真期望的那套；否则 = 已通过向量校验的移植算法）；
 *  ③ 当前值仍可用 → 保持（避免推荐 id 不在本等级列表里时跳变）；
 *  ④ 第一个非占位算法；
 *  ⑤ 兜底 list[0]（列表里只有占位算法时）。
 */
export function selectAlgorithm(
  list: readonly KeyAlgorithmDescriptor[],
  opts: { currentId?: string; recommendedId?: string | null; pickedId?: string | null },
): KeyAlgorithmDescriptor | null {
  const by = (id: string | null | undefined): KeyAlgorithmDescriptor | undefined =>
    id === null || id === undefined || id === '' ? undefined : list.find((a) => a.id === id);
  return (
    by(opts.pickedId) ??
    by(opts.recommendedId) ??
    by(opts.currentId) ??
    list.find((a) => a.origin !== 'placeholder') ??
    list[0] ??
    null
  );
}

/** 服务下拉：按 SID 升序，内置在前 */
export function sortedServices(library: UdsLibrary | null): ServiceDef[] {
  if (library === null) return [];
  return [...library.services].sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    return sidOf(a.id) - sidOf(b.id);
  });
}

export function sidOf(id: string): number {
  const value = Number.parseInt(id.replace(/^0[xX]/, ''), 16);
  return Number.isFinite(value) ? value : -1;
}

/** ★Q13：Trace 列/下拉渲染 `DSC(0x10) 诊断会话控制`（只把 hex 数字大写，保留 0x 前缀） */
export function serviceLabel(svc: ServiceDef): string {
  return `${svc.shortEn}(${svc.id.toUpperCase().replace('0X', '0x')}) ${svc.nameZh}`;
}

/** 码值显示：`0x10`（保留小写 x 前缀） */
export function codeLabel(id: string): string {
  return id.toUpperCase().replace('0X', '0x');
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  library: null,
  editorOpen: false,
  editorTab: 'services',
  issues: [],
  draft: null,
  algorithms: [],
  recommendedId: null,
  pickedAlgorithmId: null,
  vectors: [],
  trial: null,
  unlock: null,

  setLibrary: (library) => set({ library, draft: null, issues: [] }),
  openEditor: (tab) => {
    const state = get();
    // 打开编辑器时以当前库为草稿起点
    set({ editorOpen: true, editorTab: tab ?? state.editorTab, draft: null, issues: [] });
  },
  closeEditor: () => set({ editorOpen: false, draft: null }),
  setEditorTab: (editorTab) => set({ editorTab }),
  setIssues: (issues) => set({ issues }),
  setDraft: (draft) => set({ draft }),
  setAlgorithms: (algorithms, vectors, recommendedId = null) =>
    set({ algorithms, vectors, recommendedId }),
  pickAlgorithm: (id) => set({ pickedAlgorithmId: id }),
  setTrial: (trial) => set({ trial }),
  setUnlock: (unlock) => set({ unlock }),
}));
