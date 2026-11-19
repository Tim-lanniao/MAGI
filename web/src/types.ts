// 与 API.md 对齐的类型。字段名区分大小写，保持后端原样。
export type Answer = '是' | '否';
export type OutcomeAnswer = Answer | '说不清';
export type Voter = 'user' | 'gpt' | 'deepseek';
export type ModelVoter = 'gpt' | 'deepseek';
export type Status = 'running' | 'needs_confirmation' | 'paused' | 'decided' | 'failed';
export type Reversibility = '可逆' | '不可逆';
export type Severity = '致命' | '高' | '中' | '低';
export type Category = '财务' | '时间' | '健康' | '关系' | '职业' | '法律' | '机会成本' | '信息不足' | '其他';
export type ConfirmReason = 'adopt_majority' | 'keep_mine';

export const VOTERS: Voter[] = ['user', 'gpt', 'deepseek'];
export const CATEGORIES: Category[] = ['财务', '时间', '健康', '关系', '职业', '法律', '机会成本', '信息不足', '其他'];
export const SEVERITIES: Severity[] = ['致命', '高', '中', '低'];

export interface Risk {
  category: Category;
  risk: string;
  check: string;
  severity: Severity;
}

/** 影响判断的网页及其论点。联网模型票至少一项，离线票为空数组。 */
export interface Source {
  url: string;
  claim: string;
}

export interface Ballot {
  vote: Answer;
  confidence: number;
  core_reason: string;
  conditions: string[];
  risks: Risk[];
  flip_condition: string;
  /** 个人票可省略；旧数据也可能缺失，读取时按空数组处理。 */
  sources?: Source[];
}

/** model：揭晓后模型票实际使用的模型名，本人票没有。 */
export type ValidVote = { voter: Voter; state: 'valid'; model?: string } & Ballot;
export type Vote = ValidVote | { voter: ModelVoter; state: 'absent'; error: string; model?: string } | { voter: ModelVoter; state: 'pending' };

export interface MergedRisk extends Risk {
  id: string;
  voter: Voter;
  categoryMentions: number;
  mentionLabel: string;
  fromDissent: boolean;
  visible: boolean;
  checkDone: boolean;
}

export interface Tally {
  yes: number;
  no: number;
  absent: ModelVoter[];
  label: string;
  userInMinority: boolean;
  dissenters: Voter[];
}

/** 两家有效模型票引用网站的比较；离线、旧题或有模型缺席时为 null。 */
export interface SourceOverlap {
  sharedSites: string[];
  totalSites: number;
  score: number;
  warning: string | null;
}

export interface Result {
  tally: Tally;
  sourceOverlap?: SourceOverlap | null;
  conclusion: Answer | null;
  finalDecision: Answer | null;
  finalReason: ConfirmReason | null;
  finalNote: string | null;
  conditions: { voter: Voter; text: string }[];
  risks: MergedRisk[];
  pausedBy: string[];
}

export interface Outcome {
  correctAnswer: OutcomeAnswer;
  note: string | null;
  recordedAt: string;
}

export interface Detail {
  id: string;
  status: Status;
  question: string;
  needsWeb?: boolean;
  background: string;
  goals: string;
  reversibility: Reversibility;
  parentId: string | null;
  newInfo: string | null;
  createdAt: string;
  decidedAt: string | null;
  nextStatus: Status | null;
  votes: Vote[];
  result: Result | null;
  outcome: Outcome | null;
}

export interface HistoryItem {
  id: string;
  question: string;
  reversibility: Reversibility;
  status: Status;
  createdAt: string;
  decidedAt: string | null;
  parentId: string | null;
  finalDecision: Answer | null;
}

export interface HistoryPage {
  items: HistoryItem[];
  nextCursor: string | null;
}

export interface CalibrationBin {
  min: number;
  max: number;
  judged: number;
  correct: number;
  accuracy: number | null;
  avgConfidence: number | null;
}

export interface VoterStats {
  voter: Voter;
  judged: number;
  correct: number;
  accuracy: number | null;
  avgConfidence: number | null;
  calibration: CalibrationBin[];
}

export interface Stats {
  voters: VoterStats[];
}

export interface Credential {
  id: string;
  deviceName: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface LintWarning {
  field: string;
  phrase: string;
}

export interface Submission {
  question: string;
  background: string;
  goals: string;
  reversibility: Reversibility;
  parentId?: string | null;
  newInfo?: string | null;
  acknowledgeWarnings: boolean;
  needsWeb: boolean;
  userVote: Ballot;
}

export type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface ModelSelection { model: string; effort: Effort }
export type ModelSettings = Record<ModelVoter, ModelSelection>;
export interface ModelOption { id: string; label: string; efforts: Effort[] }
export type ModelOptions = Record<ModelVoter, { available: boolean; models: ModelOption[] }>;
