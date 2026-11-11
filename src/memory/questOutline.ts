/**
 * 整本大纲导入的解析器(纯函数,不读 memory、不写叶子,便于单测)。
 *
 * 玩家常把 AI 拆好的整本任务大纲整段粘进来,形态千奇百怪:
 *  - 多行缩进式:「主线任务A：考入书院 / 子任务1：报名 / 子任务2：初试」
 *  - 单行连写:「主线任务A：子任务1234：主线任务B：子任务5678」
 *  - 只有标题没有名字:「【主线任务】\n1. 考入书院\n  - 报名」
 *  - 纯平铺清单(没有任何主线/支线标记)
 *
 * 这里只做一件事:把它拆成「任务 + 归属」的条目列表,真正的写入交给 apply.importQuestOutline。
 * 解析结果会先在弹窗里预览,格式识别不对时用户能当场看出来,不会闷头写脏数据。
 */
export interface OutlineQuest {
  /** 任务名(已去掉编号、项目符号、「子任务N：」这类前缀) */
  name: string;
  /** main=主线;side=支线;子任务继承父任务的类型 */
  kind: 'main' | 'side';
  /** 父任务名(子任务才有;顶级任务为空) */
  parent?: string;
}

/** 去掉包裹的 markdown 加粗、行首项目符号与编号、首尾标点与括号 */
function cleanName(raw: string): string {
  return raw
    .replace(/\*\*/g, '')
    .replace(/^[\s#>*•·【[（(]+/, '')
    .replace(/^[-–—]\s+/, '')
    .replace(/^(?:\d+[.、)）]|[（(]\d+[)）]|[①-⑳])\s*/, '')
    .replace(/[\s:：。，,、；;】\]）)]+$/, '')
    .trim();
}

/** 清洗一条子任务:去项目符号、去「子任务/步骤/分支 + 序号 + 冒号」前缀、去编号 */
function cleanChild(raw: string): string {
  let out = raw.replace(/\*\*/g, '').trim();
  out = out.replace(/^[\s#>*•·【[（(]+/, '').replace(/^[-–—]\s+/, '');
  out = out.replace(/^(?:子任务|子项|小任务|步骤|分支)\s*\d*\s*[:：]?\s*/, '');
  out = out.replace(/^(?:\d+[.、)）]|[（(]\d+[)）]|[①-⑳])\s*/, '');
  out = out.replace(/[\s:：。，,、；;】\]）)]+$/, '').trim();
  return out;
}

/** 一段文字里可能塞了多条子任务:按换行/顿号/逗号/分号/句号拆,再按「子任务N：」再切一刀 */
function splitChildren(raw: string): string[] {
  if (!raw) return [];
  return raw
    .replace(/\r\n?/g, '\n')
    .split(/[\n、,，;；。]+/)
    .flatMap(seg => seg.split(/(?=(?:子任务|子项|小任务|步骤|分支)\s*\d*\s*[:：])/))
    .map(cleanChild)
    .filter(Boolean);
}

/**
 * 把整段大纲文本解析成任务条目。
 * 识别不到任何「主线/支线」标记时,退化为「每行一条主线任务」,避免用户粘了平铺清单后什么也没导进去。
 */
export function parseQuestOutline(raw: string): OutlineQuest[] {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n');
  // 单行连写时在标记前补换行,让「主线任务A：… 主线任务B：…」能各占一行
  const normalized = text.replace(/(主线任务|支线任务)/g, '\n$1');

  const out: OutlineQuest[] = [];
  const seen = new Set<string>();
  const push = (name: string, kind: 'main' | 'side', parent?: string): void => {
    const nm = name.trim();
    if (!nm) return;
    if (parent && parent.trim() === nm) return; // 子任务与父同名视为噪声
    const key = nm.toLowerCase();
    if (seen.has(key)) return; // 整批同名只留第一条(写入时也是按名匹配)
    seen.add(key);
    out.push(parent ? { name: nm, kind, parent } : { name: nm, kind });
  };

  let cur: { name: string; kind: 'main' | 'side' } | null = null;
  let pendingKind: 'main' | 'side' | null = null;
  let sawMarker = false;
  const loose: string[] = [];

  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    // ① 主线/支线标记行
    const m = line.match(/^(?:[\s#>*•·]+|[-–—]\s*)?(主线任务|支线任务|主线|支线)\s*(.*)$/);
    if (m) {
      sawMarker = true;
      const kind: 'main' | 'side' = m[1].startsWith('支线') ? 'side' : 'main';
      let body = m[2].trim();
      // 紧跟标记的编号/字母标签:「主线任务A：」「主线3.」
      body = body.replace(/^(?:[A-Za-z]{1,3}|\d{1,2}|[一二三四五六七八九十]{1,2})\s*[.、)）:：]\s*/, '');
      body = body.replace(/^[:：]\s*/, '');

      // 名称与内联子任务的分界:优先认「子任务/步骤」这类子任务关键词,其次认第一个冒号
      let name = body;
      let childText = '';
      const subIdx = body.search(/(?:子任务|子项|小任务|步骤|分支)/);
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
        cur = { name, kind };
        push(name, kind);
        pendingKind = null;
      } else {
        // 只有「【主线任务】」这种空标题:等下一行来当名字
        cur = null;
        pendingKind = kind;
      }
      if (cur) for (const c of splitChildren(childText)) push(c, kind, cur.name);
      continue;
    }

    // ② 空标题下面紧跟的那一行 = 任务名
    if (pendingKind && !cur) {
      const name = cleanName(line);
      if (name) {
        cur = { name, kind: pendingKind };
        push(name, pendingKind);
      }
      pendingKind = null;
      continue;
    }

    // ③ 当前任务下的子任务行
    if (cur) {
      for (const c of splitChildren(line)) push(c, cur.kind, cur.name);
      continue;
    }

    // ④ 还没有任何任务作归属(可能是开场白,也可能是纯平铺清单)
    loose.push(line);
  }

  // 完全没有标记:把剩下的每行都当主线任务
  if (!sawMarker) {
    for (const line of loose) {
      for (const name of splitChildren(line)) push(name, 'main');
    }
  }

  return out;
}
