/**
 * 镜瞳捕获(自用二改):从聊天楼层正文即时扫描「一见钟情模拟器」类卡片产出的三类结构。
 *
 * 设计与柏宝书「派生」架构一致:不持久化,每次重放从消息正文重扫 —— 原文在,档案就在;
 * 楼层被编辑/删除/翻页时自动跟随,不存在与 AI 重总结互相覆盖的问题。
 *  ① 世界观总览:【镜瞳·世界观总览】块,或 <jt_anchor> 内「总览:」段 → 场景页置顶展示 + 可注入主模型。
 *  ② 镜瞳·深度档案:「┌ 镜瞳·深度档案 ─…└」围栏块 → NPC 固定基底档案(只留客观项:
 *     已剔除「外显性格」「对主角印象/偏好」等会随剧情变化的行 —— 性格与态度由名册当前状态跟踪)。
 *  ③ 问卷回执:【一见钟情模拟器 · 问卷回执】楼层 → 解析父母/兄弟姐妹/寄宿家庭等关系字段,
 *     建成问卷 NPC 补进名册(玩家自填的亲人不必等正文出场就被记住,防「几轮后 AI 以为主角是孤儿」)。
 *
 * 性能:逐楼先做一次 includes 粗筛,无标记的普通叙事楼零正则开销。
 */

import type { STMessage } from '@/st/context';
import type { JingtongFaction, JingtongProfile, QuestionnaireNpc } from './types';

/** 与 apply.ts 的 norm 同口径(名字匹配键:去首尾空白 + 小写) */
export function normName(s: string): string {
  return String(s ?? '').trim().toLowerCase();
}

export interface JingtongScan {
  /** 世界观总览(取最后一次出现;无则空串) */
  worldOverview: string;
  /** 深度档案(按名字去重,同名取最新楼层) */
  profiles: JingtongProfile[];
  /** 问卷回执解析出的关系网 NPC(最后一次问卷为准;name=抽出的人名) */
  questionnaireNpcs: QuestionnaireNpc[];
  /** 问卷回执里的主角信息(客观字段仅兜底填空;goals/secrets 供计划/悬念种子) */
  questionnaireProtagonist: {
    gender?: string;
    age?: string;
    appearance?: string;
    /** 关系定位(如「右位」)→ 身份栏兜底 */
    identity?: string;
    /** 性格/行事风格 → 主角稳定人设兜底 */
    personality?: string;
    /** 家境/出身/父母等合并 → 主角稳定背景兜底 */
    background?: string;
    /** 长远目标(计划种子) */
    goals?: string[];
    /** 秘密条目(悬念种子;知情人信息拼进对应条目) */
    secrets?: string[];
  };
  /** 问卷「备注」段原文(人物小传/世界设定备忘,注入主模型防 OOC) */
  notes: string;
  /** 世界观总览「权力与势力」段捕捉的势力种子(取最后一次总览;手动可增删改,墓碑防复活) */
  factions: JingtongFaction[];
}

function floorText(m: STMessage | undefined): string {
  return typeof m?.mes === 'string' ? m.mes : '';
}

/**
 * 剥掉思维链块(<think>、<think_nya>、<thinking> 等同族标签),防止卡片思考过程里的
 * 输出模板/规划文被当成正文捕捉。已闭合的整块剥除;未闭合的从开标签剥到楼尾。
 */
function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think[^>]*>[\s\S]*?<\/think[^>]*>/gi, '')
    .replace(/<think[^>]*>[\s\S]*$/i, '');
}

/* ============ ① 世界观总览 ============ */

/**
 * 从单楼正文提取世界观总览:
 *  - 形态 A:【镜瞳·世界观总览】独立标题块,取标题后到下一个【块/锚点/状态栏为止的正文;
 *  - 形态 B:<jt_anchor> 围栏内「总览:」段,到「档案N:」或围栏结束为止;
 *  - 形态 C:「┌ 镜瞳·世界观总览 ─…└」围栏块(与深度档案同款画框)。
 *    结尾兜底:闭栏 └ 缺失时,截到下一个 ┌ 开栏 / </game> / 状态栏为止,防止吞掉后续正文。
 */
function extractWorldOverview(text: string): string {
  const marked = text.match(/【镜瞳[·・]世界观总览】[ \t]*\r?\n?([\s\S]*?)(?=\r?\n【|<jt_anchor>|<jt_status>|$)/);
  if (marked?.[1]?.trim()) return marked[1].trim();
  const anchor = text.match(/<jt_anchor>([\s\S]*?)(?:<\/jt_anchor>|$)/);
  const ov = anchor?.[1]?.match(/总览[：:][ \t]*\r?\n?([\s\S]*?)(?=\r?\n\s*档案\d+[：:]|$)/);
  if (ov?.[1]?.trim()) return ov[1].trim();
  const fenced = text.match(/┌[^\n]*镜瞳[·・]世界观总览[^\n]*\n([\s\S]*?)(?=\r?\n[^\S\n]*└|\r?\n\s*┌|<\/game>|<jt_status>|$)/);
  if (fenced?.[1]?.trim()) return fenced[1].trim();
  return '';
}

/* ============ ①b 世界观总览·「权力与势力」段 → 势力种子 ============ */

/** 常见权力动词:条目里动词前的短语视为势力名,动词起视为权力描述(可在 UI 里改) */
const FACTION_POWER_VERB = /(掌管|把控|统治|控制|掌握|主导|把持|垄断|操纵|掌控|领导|支配|管理)/;

/** 组织后缀(保守集,按长短排前面优先整词匹配):用于从整句里抽短势力名。单字「会/社」歧义大,不收 */
const FACTION_SUFFIX_RE = /(家族|集团|财团|资本|商会|公司|王朝|帝国|王国|朝廷|王室|门阀|世家|门派|教会|组织|学院|家|氏|门|派)/g;
/** 短名黑名单:后缀「家/门/派」极易命中日常词,这些组合不算势力 */
const FACTION_NAME_BLOCK = /^(社会|大家|人家|自家|国家|玩家|厂家|东家|行家|商家会|前后门|热门|冷门|派头|派送|派遣)/;

/**
 * 从整句里抽「短势力名」:扫最早出现的组织后缀,取其前紧邻的 1-4 个汉字作前缀,同位取最短。
 * 例:「老牌政商楚家由楚律维掌舵稳控大局」→「楚家」;「晏氏资本冷眼旁观…」→「晏氏」。
 * 抽不出(无后缀词/前缀跨非汉字)返回空串。
 */
function shortenFactionName(entry: string): string {
  let best = '';
  for (const m of entry.matchAll(FACTION_SUFFIX_RE)) {
    const end = (m.index ?? 0) + m[0].length;
    for (let len = 1; len <= 4; len++) {
      const start = end - m[0].length - len;
      if (start < 0) break;
      const pre = entry.slice(start, end - m[0].length);
      if (!/^[\u4e00-\u9fa5]{1,4}$/.test(pre)) continue;
      const cand = pre + m[0];
      if (FACTION_NAME_BLOCK.test(cand)) break;
      if (!best || cand.length < best.length) best = cand;
      break;
    }
    break; // 只取最早出现的后缀(句子通常先给主语势力)
  }
  return best;
}

/**
 * 从世界观总览里截出「权力与势力」段的正文:
 * 标题行(带 ③/数字 编号或以关键词开头)的余文 + 后续行,直到下一个编号标题/【块标题为止。
 * 只认行首编号或关键词开头的行,防把叙事句「各势力暗流涌动」误当标题。
 */
function extractFactionSection(overview: string): string {
  const lines = overview.split(/\r?\n/);
  const parts: string[] = [];
  let active = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (!active) {
      const head = t.match(/^(?:[①-⑳]\s*|\d{1,2}[、.．]\s*)?(?:权力与势力|权力格局|势力分布|势力|权力)(?:[：:]\s*(.*))?$/);
      if (head) {
        active = true;
        if (head[1]?.trim()) parts.push(head[1].trim());
      }
      continue;
    }
    // 段内终止:下一个编号标题 / 【块标题
    if (/^[①-⑳]/.test(t) || /^\d{1,2}[、.．]/.test(t) || /^【/.test(t)) break;
    if (t) parts.push(t);
  }
  return parts.join('\n');
}

/**
 * 势力种子捕捉:权力与势力段按分号/换行拆条,每条用权力动词拆「名 | 权力描述」。
 * 拆不出动词则试「名：描述」;再拆不出整条为名(desc 空,留给 AI 摘要或手动补)。
 * 例:「校董会与老钱赞助家族掌管资源分配与招生特权」→ 名「校董会与老钱赞助家族」,
 * desc「掌管资源分配与招生特权」。
 */
export function extractFactions(overview: string): JingtongFaction[] {
  const section = extractFactionSection(overview);
  if (!section) return [];
  const out: JingtongFaction[] = [];
  const seen = new Set<string>();
  for (const rawEntry of section.split(/[；;\n]+/)) {
    const entry = rawEntry.trim().replace(/^[-•·▪◦*]+\s*/, '').replace(/[。．.]$/, '');
    if (!entry) continue;
    let name = '';
    let desc = '';
    const vm = FACTION_POWER_VERB.exec(entry);
    if (vm && vm.index > 0) {
      name = entry.slice(0, vm.index).trim();
      desc = entry.slice(vm.index).trim();
    } else {
      // 动词拆不动(动词缺席或在最前):试「名：描述」/「名——描述」
      const sm = entry.match(/^(.{1,24}?)[：:——]\s*(.+)$/);
      if (sm && vm === null) {
        name = sm[1].trim();
        desc = sm[2].trim();
      } else {
        name = entry;
      }
    }
    name = name.replace(/^[「『"']+|[」』"']+$/g, '').trim();
    // 名字过长(动词拆不动/拆出了半句):试抽短势力名,整句转作描述 —— 防止「老牌政商楚家由楚律维掌舵稳控大局」这种整句卡名
    // 阈值 >6:短名一般 2-4 字,7 字起就该怀疑混入了描述(如「晏氏资本冷眼旁观」)
    if (name.length > 6) {
      const short = shortenFactionName(name);
      if (short && short.length < name.length && !seen.has(normName(short))) {
        if (!desc) desc = name;
        name = short;
      }
    }
    const key = normName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(desc ? { name, desc } : { name });
    if (out.length >= 12) break; // 兜底上限:畸形段落不至于灌满名册
  }
  return out;
}

/* ============ ② 镜瞳·深度档案 ============ */

/** 档案行里要剔除的易变项:外显性格(变量)、对主角印象/偏好(初始印象,由名册好感/状态跟踪) */
const PROFILE_LINE_SKIP = /^(外显性格|对.{1,12}印象|偏好)/;

/**
 * 把紧凑首行「姓名｜年龄｜身高｜体重:朱利安·凡斯|18岁|188cm|82kg」展开成多行「标签:值」,
 * 展示与注入都更易读(卡片模板保持单行省 token,展开在捕捉端做,旧楼层自动受益)。
 * 标签/值数量不齐时兜底:值少补空,值多并入末行,解析失败原样返回。
 */
function expandHeadLine(line: string): string {
  const m = line.match(/^(姓名|名字)((?:[｜|][^：:]*)*)[：:]\s*(.+)$/);
  if (!m) return line;
  const labels = [m[1], ...m[2].split(/[｜|]/).map(s => s.trim()).filter(Boolean)];
  const values = m[3].split(/[｜|]/).map(s => s.trim()).filter(Boolean);
  // 已是「姓名:XX」普通形态或值不足两条,视为无需展开
  if (labels.length < 2 || values.length < 2) return line;
  const rows: string[] = [];
  for (let i = 0; i < labels.length; i++) rows.push(`${labels[i]}：${values[i] ?? ''}`);
  if (values.length > labels.length) rows[rows.length - 1] += `｜${values.slice(labels.length).join('｜')}`;
  return rows.join('\n');
}

/** 从单楼正文提取全部「┌ 镜瞳·深度档案 ─…└」块,按名字写入 out(同名后到覆盖先到)。闭栏缺失时兜底截断,同总览。 */
function extractProfiles(text: string, floor: number, out: Map<string, JingtongProfile>): void {
  const re = /┌[^\n]*镜瞳[·・]深度档案[^\n]*\n([\s\S]*?)(?=\r?\n[^\S\n]*└|\r?\n\s*┌|<\/game>|<jt_status>|$)/g;
  for (const m of text.matchAll(re)) {
    const lines = m[1]
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean);
    if (!lines.length) continue;
    // 名字:优先「姓名|年龄|身高|体重:周砚清|25岁|…」首段;回退「姓名:XX」「名字:XX」
    let name = '';
    const head = lines.find(l => /^(姓名|名字)/.test(l));
    const hm = head?.match(/^(?:姓名|名字)[^：:]*[：:]\s*(.+)$/);
    if (hm) name = hm[1].split(/[｜|]/)[0].trim();
    if (!name) continue;
    const kept = lines.map(l => (/^(姓名|名字)/.test(l) ? expandHeadLine(l) : l)).filter(l => !PROFILE_LINE_SKIP.test(l));
    out.set(normName(name), { name, text: kept.join('\n'), floor });
  }
}

/* ============ ③ 问卷回执 ============ */

const QS_HEADER = /【一见钟情模拟器\s*[·・]\s*问卷回执】/;

/** 视为「留白」的字段值:空、无、AI补 等 */
function badVal(v: string | undefined): boolean {
  const t = (v ?? '').trim();
  return !t || /^(无|没有|暂无|AI补|略|保密|不详|不适用)$/i.test(t);
}

/** 把楼层正文按行拆成「字段:值」表(问卷楼层内逐行匹配,先到先得) */
function parseQuestionnaireFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('——')) continue;
    const m = line.match(/^([\u4e00-\u9fa5A-Za-z0-9/·・]{1,14})\s*[：:]\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    if (!(key in fields)) fields[key] = m[2].trim();
  }
  return fields;
}

/**
 * 从关系字段值里抽具体人名:首个分句若以 2-3 个纯汉字短名开头(「楚奕是我男朋友…」「林薇，大学室友」)
 * 则抽之;泛称/叙述性开头(「爸妈都是…」「无」「AI补」)抽不到 → 返回空串,调用方不建卡。
 */
function extractPersonName(v: string | undefined): string {
  const t = (v ?? '').trim();
  if (!t) return '';
  const head = t.split(/[，,。;；、\n]/)[0].trim();
  const m = head.match(/^([\u4e00-\u9fa5]{2,3})(?:是我|是|就是我|——|—|$)/);
  return m ? m[1] : '';
}

/** 关系字段 → 问卷 NPC 条目:从玩家原文抽出**具体人名**当 name(relation 仍存称谓键),desc 保真存原文 */
function buildQuestionnaireNpcs(f: Record<string, string>): QuestionnaireNpc[] {
  const out: QuestionnaireNpc[] = [];
  const push = (relation: string, v: string | undefined) => {
    if (badVal(v)) return;
    const name = extractPersonName(v);
    if (!name) return; // 抽不出具体人(泛称/无/AI补):不建空壳卡;原文已并入主角背景/备注,信息不丢
    out.push({ name, relation, desc: (v ?? '').trim() });
  };
  push('父母', f['父母']);
  push('兄弟姐妹', f['兄弟姐妹']);
  push('亲戚', f['亲戚']);
  push('子女', f['孩子']);
  push('恋人', f['情人/交往对象']);
  push('朋友', f['朋友']);
  push('敌对', f['对立/敌对关系']);
  // 社交圈只保留寄宿/寄养家庭(是「一个家」的完整信息,值得立条);普通同学圈不建人卡
  const social = [f['社交圈'], f['社交圈补充']].filter(v => !badVal(v)).join('\n').trim();
  if (/寄宿家庭|寄养家庭/.test(social)) push('寄宿家庭', social);
  return out;
}

/**
 * 抓「备注」段原文:从「备注：」行起,收集到下一个字段行/分段线为止。
 * 备注常是多行人物小传(楚律维/晏礼等人设),parseQuestionnaireFields 只留首行会丢文,故单独抓整段。
 */
function parseNotesSection(text: string): string {
  const lines = text.split(/\r?\n/);
  const parts: string[] = [];
  let active = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (!active) {
      // 段头两种形态:「备注:xxx」或独立段头行「—— 备注 ——」
      const m = t.match(/^备注\s*[：:]\s*(.*)$/);
      if (m) {
        active = true;
        if (m[1].trim()) parts.push(m[1].trim());
      } else if (/^[-—\s]*备注\s*[-—\s]*$/.test(t)) {
        active = true;
      }
      continue;
    }
    // 段尾:分段线(——)或新字段行(「长远目标:…」「开局场景:…」)
    if (/^——/.test(t)) break;
    if (/^[\u4e00-\u9fa5A-Za-z0-9/·・]{1,14}\s*[：:]/.test(t)) break;
    if (t) parts.push(t);
  }
  return parts.join('\n').trim();
}

/* ============ 总扫描 ============ */

/** 扫全 chat:世界观总览(最后一次)、深度档案(同名取最新)、问卷(最后一次) */
export function scanJingtong(chat: STMessage[] | null | undefined): JingtongScan {
  const profiles = new Map<string, JingtongProfile>();
  let worldOverview = '';
  let questionnaireNpcs: QuestionnaireNpc[] = [];
  let factions: JingtongFaction[] = [];
  let notes = '';
  const qp: NonNullable<JingtongScan['questionnaireProtagonist']> = {};
  if (chat) {
    for (let i = 0; i < chat.length; i++) {
      const m = chat[i];
      if (m?.extra?.bbs_omit) continue; // 番外楼:不参与
      const raw = floorText(m);
      if (!raw) continue;
      // 先剥思维链,再做粗筛与提取(思考块里的输出模板不该被当成正文捕捉)
      const text = stripThinkBlocks(raw);
      if (!text.includes('镜瞳') && !text.includes('问卷回执')) continue;
      const ov = extractWorldOverview(text);
      if (ov) {
        worldOverview = ov;
        factions = extractFactions(ov); // 势力种子跟随最后一次总览(与 worldOverview 同源)
      }
      extractProfiles(text, i, profiles);
      if (QS_HEADER.test(text)) {
        const f = parseQuestionnaireFields(text);
        const npcs = buildQuestionnaireNpcs(f);
        if (npcs.length) questionnaireNpcs = npcs;
        const g = (f['性别'] ?? '').trim();
        if (/^(男|女)$/.test(g)) qp.gender = g;
        if (!badVal(f['年龄'])) qp.age = f['年龄'].trim();
        if (!badVal(f['外貌'])) qp.appearance = f['外貌'].trim();
        if (!badVal(f['关系定位'])) qp.identity = f['关系定位'].trim();
        if (!badVal(f['性格'])) qp.personality = f['性格'].trim();
        // 稳定背景:家境/出身/父母等非留白值合并(「父母:无,我是在孤儿院长大的」这类带叙述的留白值也收进来)
        const bgParts: string[] = [];
        for (const key of ['家境', '出身', '父母', '兄弟姐妹', '亲戚']) {
          const v = f[key]?.trim();
          if (!badVal(v)) bgParts.push(`${key}：${v}`);
        }
        if (bgParts.length) qp.background = bgParts.join('；');
        // 长远目标 → 计划种子;秘密(剥掉 1️⃣ 序号后按分号拆条) → 悬念种子
        const goal = f['长远目标']?.trim();
        if (!badVal(goal)) qp.goals = goal.split(/[；;]/).map(s => s.trim()).filter(Boolean);
        const secret = f['秘密']?.trim();
        if (!badVal(secret)) {
          const stripNums = (s: string): string => s.replace(/[0-9①②③④⑤⑥⑦⑧⑨⑩]️⃣/g, '').trim();
          const segs = stripNums(secret).split(/[；;]/).map(s => s.trim()).filter(Boolean);
          const know = f['知情人']?.trim();
          const kn = know && !badVal(know) ? stripNums(know).split(/[；;]/).map(s => s.trim()).filter(Boolean) : [];
          qp.secrets = segs.map((s, idx) => (kn[idx] ? `${s}（知情情况：${kn[idx]}）` : s));
        }
        // 备注整段(人物小传/世界设定备忘)
        const nm = parseNotesSection(text);
        if (nm) notes = nm;
      }
    }
  }
  return { worldOverview, profiles: [...profiles.values()], questionnaireNpcs, questionnaireProtagonist: qp, notes, factions };
}
