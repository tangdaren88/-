/**
 * 任务子任务树回归(v1.6.2):
 *  - buildQuestDraft 推进草稿:纯模板拼装,保留 {{user}} 宏字面量
 *  - 任务 delta 重放支持 parent(子任务归属;空串清除;父被删子悬空不动)
 *  - 手动父任务改名的级联 op 形状(remove+add+子任务 parent 批量 update)在重放层生效
 */
import { describe, expect, it } from 'vitest';
import { deriveMemory } from './apply';
import { buildQuestDraft } from './inject';
import { parseQuestOutline } from './questOutline';
import type { MemQuest } from './types';
import type { STMessage } from '@/st/context';

function msg(mes: string, delta?: Record<string, unknown>): STMessage {
  const m = { mes, is_user: false, name: 'Char' } as unknown as STMessage;
  if (delta) m.extra = { bbs_leaf: { id: `leaf-${Math.random().toString(36).slice(2)}`, delta } } as STMessage['extra'];
  return m;
}

const BASE_QUEST: MemQuest = {
  id: 'quest:南海历练',
  name: '南海历练',
  kind: 'main',
  desc: '前往南海历练,突破筑基',
  progress: '已收到宗门传讯',
  status: 'active',
  faction: '青云宗',
  createdAt: 0,
  updatedAt: 0,
};

describe('buildQuestDraft 推进草稿', () => {
  it('主线任务:含任务名/目标/进展/关联势力与{{user}}宏字面量', () => {
    const draft = buildQuestDraft(BASE_QUEST);
    expect(draft).toContain('南海历练');
    expect(draft).toContain('主线任务');
    expect(draft).toContain('前往南海历练,突破筑基');
    expect(draft).toContain('已收到宗门传讯');
    expect(draft).toContain('青云宗');
    expect(draft).toContain('{{user}}');
  });

  it('支线任务标注支线;空描述任务不炸且仍含任务名', () => {
    expect(buildQuestDraft({ ...BASE_QUEST, kind: 'side' })).toContain('支线任务');
    const bare = buildQuestDraft({ ...BASE_QUEST, desc: undefined, progress: undefined, faction: undefined });
    expect(bare).toContain('南海历练');
    expect(bare).toContain('{{user}}');
  });
});

describe('任务子任务树(重放层)', () => {
  it('add 带 parent:子任务归属父任务名下', () => {
    const mem = deriveMemory([
      msg('剧情。', { quests: { add: [{ name: '南海历练', kind: 'main' }, { name: '收集船票', kind: 'side', parent: '南海历练' }] } }),
    ]);
    const child = mem.quests.find(q => q.name === '收集船票');
    expect(child?.parent).toBe('南海历练');
    expect(mem.quests.find(q => q.name === '南海历练')?.parent).toBeUndefined();
  });

  it('update parent 为空串清除归属;悬空父名数据不动(渲染层视作顶级)', () => {
    const m1 = msg('剧情。', { quests: { add: [{ name: '南海历练' }, { name: '收集船票', parent: '南海历练' }] } });
    const mem1 = deriveMemory([m1]);
    expect(mem1.quests.find(q => q.name === '收集船票')?.parent).toBe('南海历练');

    const m2 = msg('后文。');
    m2.extra = { bbs_leaf: { id: 'leaf-2', delta: { quests: { update: [{ name: '收集船票', parent: '' }] } } } } as STMessage['extra'];
    expect(deriveMemory([m1, m2]).quests.find(q => q.name === '收集船票')?.parent).toBeUndefined();

    // 删除父任务:子任务保留原 parent(悬空),页面渲染时视作顶级
    const m3 = msg('后文。');
    m3.extra = { bbs_leaf: { id: 'leaf-3', delta: { quests: { remove: ['南海历练'] } } } } as STMessage['extra'];
    const mem3 = deriveMemory([m1, m3]);
    expect(mem3.quests.some(q => q.name === '南海历练')).toBe(false);
    expect(mem3.quests.find(q => q.name === '收集船票')?.parent).toBe('南海历练');
  });

  it('父任务改名级联:remove+add+子任务 parent 批量 update 的手动 op 形状在重放层生效', () => {
    const m1 = msg('剧情。', { quests: { add: [{ name: '南海历练' }, { name: '收集船票', parent: '南海历练' }, { name: '打探航线', parent: '南海历练' }] } });
    const m2 = msg('后文。');
    // 模拟 editQuest 改名产出的 op 形状
    m2.extra = {
      bbs_leaf: {
        id: 'leaf-2',
        delta: {
          quests: {
            remove: ['南海历练'],
            add: [{ name: '东海历练', kind: 'main' }],
            update: [{ name: '收集船票', parent: '东海历练' }, { name: '打探航线', parent: '东海历练' }],
          },
        },
      },
    } as STMessage['extra'];
    const mem = deriveMemory([m1, m2]);
    expect(mem.quests.some(q => q.name === '南海历练')).toBe(false);
    expect(mem.quests.some(q => q.name === '东海历练')).toBe(true);
    expect(mem.quests.find(q => q.name === '收集船票')?.parent).toBe('东海历练');
    expect(mem.quests.find(q => q.name === '打探航线')?.parent).toBe('东海历练');
  });
});

describe('整本大纲解析(parseQuestOutline)', () => {
  it('多行缩进式:主线下挂子任务,支线继承支线类型', () => {
    const outline = [
      '主线任务A：考入天枢书院',
      '子任务1：报名',
      '子任务2：初试',
      '支线任务C：寻找旧友',
      '子任务1：打听下落',
    ].join('\n');
    const list = parseQuestOutline(outline);
    expect(list.map(q => q.name)).toEqual(['考入天枢书院', '报名', '初试', '寻找旧友', '打听下落']);
    expect(list[0]).toMatchObject({ kind: 'main' });
    expect(list[1]).toMatchObject({ kind: 'main', parent: '考入天枢书院' });
    expect(list[3]).toMatchObject({ kind: 'side' });
    expect(list[4]).toMatchObject({ kind: 'side', parent: '寻找旧友' });
  });

  it('单行连写:标记间自动断行,各自成为独立任务', () => {
    const list = parseQuestOutline('主线任务A：考入书院：子任务1：报名、子任务2：初试：主线任务B：南海历练');
    const names = list.map(q => q.name);
    expect(names).toContain('考入书院');
    expect(names).toContain('报名');
    expect(names).toContain('初试');
    expect(names).toContain('南海历练');
    // 南海历练在第二个标记后,不能挂到第一个任务名下
    expect(list.find(q => q.name === '南海历练')?.parent).toBeUndefined();
  });

  it('空标题式:任务名取下一行,缩进行作子任务', () => {
    const list = parseQuestOutline(['【主线任务】', '1. 考入书院', '  - 报名', '  - 初试'].join('\n'));
    expect(list.map(q => q.name)).toEqual(['考入书院', '报名', '初试']);
    expect(list[1].parent).toBe('考入书院');
  });

  it('无任何标记时退化为逐行主线任务;整批重名只留一条', () => {
    const list = parseQuestOutline('考学校\n历练\n飞升\n考学校');
    expect(list.map(q => q.name)).toEqual(['考学校', '历练', '飞升']);
    expect(list.every(q => q.kind === 'main' && !q.parent)).toBe(true);
  });
});
