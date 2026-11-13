/**
 * 整本大纲导入的解析器(纯函数,不读 memory、不写叶子,便于单测)。
 *
 * 玩家把 AI 拆好的整本任务大纲整段粘进来,形态千奇百怪:
 *  - 多行缩进式:「主线任务A：考入书院 / 描述：…… / 子任务1：报名 / 子任务2：初试」
 *  - 单行连写:「主线任务A：…：主线任务B：…」
 *  - 只有标题没有名字:「【主线任务】\n1. 考入书院\n  - 报名」
 *  - 支线名字带括注:「支线任务B：九龙拉棺之谜（主线任务A进行期间可接）」
 *  - 纯平铺清单(没有任何主线/支线标记)
 *
 * 这里只做一件事:把它拆成「任务 + 归属 + 描述」的条目列表,真正的写入交给 apply.importQuestOutline。
 * 解析结果会先在弹窗里预览,格式识别不对时用户能当场看出来,不会闷头写脏数据。
 */
export interface OutlineQuest {
  /** 任务名(已去掉编号、项目符号、「子任务N：」这类前缀) */
  name: string;
  /** main=主线;side=支线;子任务继承父任务的类型 */
  kind: 'main' | 'side';
  /** 父任务名(子任务才有;顶级任务为空) */
  parent?: string;
  /** 目标描述(来自「描述：」「目标：」这类行) */
  desc?: string;
}

/** 描述行标记:这类行是上一条任务的目标描述,不是子任务 */
const DESC_RE = /^(?:任务)?(?:描述|目标|说明|简述|目标描述)\s*[:：]\s*(.*)$/;
const SUB_LABEL = '(?:子任务|子项|小任务|步骤|分支)';

/** 去掉行首的 markdown 记号、项目符号、开括号 */
function stripLead(raw: string): string {
  return raw
    .replace(/\*\*/g, '')
    .replace(/^[\s#>*•·【[（(]+/, '')
    .replace(/^[-–—]\s+/, '');
}

/**
 * 去掉首尾标点与括号。
 * 特别注意:成对的括注要保留(支线任务名后面常跟「（主线任务A进行期间可接）」),
 * 只有落单的右括号(装饰残留)才剥掉,否则会把括注切坏。
 */
function trimEndPunct(raw: string): string {
  let out = raw.replace(/\*\*/g, '').trim();
  out = out.replace(/[\s:：。，,、；;】\]]+$/, '').trim();
  while (/[）)]$/.test(out) && !/[（(]/.test(out)) out = out.slice(0, -1).trim();
  while (/[（(]$/.test(out)) out = out.slice(0, -1).trim();
  return out.replace(/[\s:：。，,、；;]+$/, '').trim();
}

/** 去掉行首编号:「1. 」「(1)」「①」「2.1：」 */
function stripNumber(raw: string): string {
  return raw
    .replace(/^\d+(?:\.\d+)*\s*[.、)）:：]\s*/, '')
    .replace(/^\d+(?:\.\d+)*\s+/, '')
    .replace(/^[（(]\d+[)）]\s*/, '')
    .replace(/^[①-⑳]\s*/, '');
}

/** 任务名(顶级任务用) */
function cleanName(raw: string): string {
  return trimEndPunct(stripNumber(stripLead(raw)));
}

/** 子任务名(额外剥掉「子任务N：」前缀) */
function cleanChild(raw: string): string {
  const s = stripLead(raw.trim());
  const noLabel = s.replace(new RegExp(`^${SUB_LABEL}\\s*\\d+(?:\\.\\d+)*\\s*[:：]?\\s*`), '');
  return trimEndPunct(stripNumber(noLabel));
}

/** 取子任务自带的多级序号(「子任务2.1：」→ 2.1),用于还原 2 → 2.1 的嵌套 */
function childNumber(raw: string): string {
  const s = stripLead(raw.trim());
  const m =
    s.match(new RegExp(`^${SUB_LABEL}\\s*(\\d+(?:\\.\\d+)*)`)) ?? s.match(/^(\d+(?:\.\d+)*)\s*[.、)）:：\s]/);
  return m ? m[1] : '';
}

/** 一段文字里可能塞了多条子任务:按换行/顿号/逗号/分号/句号拆,再按「子任务N：」再切一刀 */
function splitChildItems(raw: string): { name: string; num: string }[] {
  if (!raw) return [];
  return raw
    .replace(/\r\n?/g, '\n')
    .split(/[\n、,，;；。]+/)
    .flatMap(seg => seg.split(new RegExp(`(?=${SUB_LABEL}\\s*\\d+(?:\\.\\d+)*\\s*[:：])`)))
    .map(seg => ({ name: cleanChild(seg), num: childNumber(seg) }))
    .filter(x => !!x.name);
}

/**
 * 把整段文本切成一段段「从主线/支线标记开头」的片段。
 * 只在括号外、且不在行首时才切 —— 这样
 *  · 「主线任务A：…：主线任务B：…」单行连写能拆开;
 *  · 「支线任务B：xxx（主线任务A进行期间可接）」里的括注不会被切坏。
 */
function splitTopLevelSegments(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    let depth = 0;
    let seg = '';
    for (let i = 0; i < line.length; i++) {
      if (
        depth === 0 &&
        seg.trim() &&
        (line.startsWith('主线任务', i) || line.startsWith('支线任务', i))
      ) {
        out.push(seg);
        seg = '';
      }
      const ch = line[i];
      if (ch === '（' || ch === '(') depth++;
      else if (ch === '）' || ch === ')') depth = Math.max(0, depth - 1);
      seg += ch;
    }
    out.push(seg);
  }
  return out.filter(s => s.trim());
}

/**
 * 把整段大纲文本解析成任务条目。
 * 识别不到任何「主线/支线」标记时,退化为「每行一条主线任务」,避免用户粘了平铺清单后什么也没导进去。
 */
export function parseQuestOutline(raw: string): OutlineQuest[] {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n');

  const out: OutlineQuest[] = [];
  const byKey = new Map<string, OutlineQuest>();
  /** 每个父任务下已出现的序号 → 子任务名,用于把 2.1 挂回 2 下面 */
  const numbers = new Map<string, Map<string, string>>();
  const pkey = (name?: string): string => (name ? name.trim().toLowerCase() : '');

  const push = (name: string, kind: 'main' | 'side', parent?: string, desc?: string): OutlineQuest | null => {
    const nm = name.trim();
    if (!nm) return null;
    if (parent && parent.trim().toLowerCase() === nm.toLowerCase()) return null; // 子任务与父同名视为噪声
    const key = nm.toLowerCase();
    const ex = byKey.get(key);
    if (ex) {
      if (desc && !ex.desc) ex.desc = desc; // 同名重复出现时只补描述
      return ex;
    }
    const entry: OutlineQuest = { name: nm, kind, ...(parent ? { parent } : {}), ...(desc ? { desc } : {}) };
    byKey.set(key, entry);
    out.push(entry);
    return entry;
  };

  const rememberNum = (parent: string | undefined, num: string, name: string) => {
    if (!num) return;
    const k = pkey(parent);
    const m = numbers.get(k) ?? new Map<string, string>();
    m.set(num, name);
    numbers.set(k, m);
  };
  const siblingByNum = (parent: string | undefined, num: string): string | undefined =>
    numbers.get(pkey(parent))?.get(num);

  let curParent: { name: string; kind: 'main' | 'side' } | null = null;
  let last: OutlineQuest | null = null;
  let pendingKind: 'main' | 'side' | null = null;
  let sawMarker = false;
  const loose: string[] = [];

  const attachChildLine = (line: string) => {
    if (!curParent) return;
    for (const item of splitChildItems(line)) {
      // 多级序号:2.1 挂到同级 2 的名下(找不到父序号就仍挂当前任务)
      let owner = curParent.name;
      if (item.num.includes('.')) {
        const prefix = item.num.slice(0, item.num.lastIndexOf('.'));
        owner = siblingByNum(curParent.name, prefix) ?? owner;
      }
      const e = push(item.name, curParent.kind, owner);
      if (e) {
        last = e;
        rememberNum(owner, item.num, item.name);
      }
    }
  };

  for (const segment of splitTopLevelSegments(text)) {
    const line = segment.trim();
    if (!line) continue;

    // ① 描述行:挂给上一条任务(顶级或子任务),绝不当子任务拆
    const dm = line.match(DESC_RE);
    if (dm) {
      const body = dm[1].trim();
      if (last && body && !last.desc) last.desc = body;
      continue;
    }

    // ② 主线/支线标记行
    const m = line.match(/^(?:[\s#>*•·【[]+|[-–—]\s*)?(主线任务|支线任务|主线|支线)\s*(.*)$/);
    if (m) {
      sawMarker = true;
      const kind: 'main' | 'side' = m[1].startsWith('支线') ? 'side' : 'main';
      let body = m[2].trim();
      // 紧跟标记的编号/字母标签:「主线任务A：」「主线3.」
      body = body.replace(/^(?:[A-Za-z]{1,3}|\d+(?:\.\d+)*|[一二三四五六七八九十]{1,2})\s*[.、)）:：]\s*/, '');
      body = body.replace(/^[:：]\s*/, '');

      // 名称与内联子任务的分界:优先认「子任务/步骤」这类子任务关键词,其次认第一个冒号
      let name = body;
      let childText = '';
      const subIdx = body.search(new RegExp(SUB_LABEL));
      if (subIdx > 0) {
        name = body.slice(0, subIdx);
        childText = body.slice(subIdx);
      } else if (subIdx === 0) {
        name = '';
        childText = body;
      } else {
        const ci = body.search(/[:：]/);
        if (ci >= 0) {
          name = body.slice(0, ci);
          childText = body.slice(ci + 1);
        }
      }

      name = cleanName(name);
      if (name) {
        const e = push(name, kind);
        curParent = { name, kind };
        last = e;
        pendingKind = null;
      } else {
        // 只有「【主线任务】」这种空标题:等下一行来当名字
        curParent = null;
        last = null;
        pendingKind = kind;
      }
      if (curParent) attachChildLine(childText);
      continue;
    }

    // ③ 空标题下面紧跟的那一行 = 任务名
    if (pendingKind && !curParent) {
      const name = cleanName(line);
      if (name) {
        const e = push(name, pendingKind);
        curParent = { name, kind: pendingKind };
        last = e;
      }
      pendingKind = null;
      continue;
    }

    // ④ 当前任务下的子任务行
    if (curParent) {
      attachChildLine(line);
      continue;
    }

    // ⑤ 还没有任何任务作归属(可能是开场白,也可能是纯平铺清单)
    loose.push(line);
  }

  // 完全没有标记:把剩下的每行都当主线任务(描述行仍归上一条)
  if (!sawMarker) {
    for (const line of loose) {
      const dm = line.match(DESC_RE);
      if (dm) {
        const body = dm[1].trim();
        if (last && body && !last.desc) last.desc = body;
        continue;
      }
      for (const item of splitChildItems(line)) {
        const e = push(item.name, 'main');
        if (e) last = e;
      }
    }
  }

  return out;
}
