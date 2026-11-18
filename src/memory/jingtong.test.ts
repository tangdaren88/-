/**
 * 镜瞳问卷深建档回归(v1.5.0):
 *  - 问卷主角稳定人设(personality/background/identity)入档
 *  - 长远目标/秘密 → 计划/悬念种子(可被手动 resolve/remove,不复活)
 *  - 问卷关系字段抽真名(不再产「父母/朋友」空壳卡)
 *  - 势力种子短名提取(不再整句卡名)
 *  - 问卷备注段入派生缓存
 */
import { describe, expect, it, vi } from 'vitest';
import { deriveMemory } from './apply';
import { scanJingtong } from './jingtong';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory } from './types';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';

function msg(mes: string): STMessage {
  return { mes, is_user: false, name: 'Char' } as unknown as STMessage;
}

const QUESTIONNAIRE = [
  '【一见钟情模拟器 · 问卷回执】',
  '—— 关于你 · 基本 ——',
  '姓名：贺卿',
  '性别：女',
  '年龄：18',
  '关系定位：右位',
  '性格：很会装可怜，能屈能伸，演技好，没什么道德枷锁',
  '—— 出身与家庭 ——',
  '家境：贫穷',
  '父母：无，我是在孤儿院长大的',
  '兄弟姐妹：无',
  '秘密：1️⃣楚律维是资助人，我并不知道资助人是谁；2️⃣楚奕楚则双胞胎有身体感应；3️⃣晏礼身负诅咒',
  '知情人：1️⃣只有院长知道；2️⃣只有他们自己知道；3️⃣只有他自己知道',
  '—— 感情状况 ——',
  '情人/交往对象：楚奕是我男朋友，今年大三',
  '朋友：林薇，大学室友',
  '—— 备注 ——',
  '这本小说世界中，楚家是老牌政商豪门，这一代家主是楚律维，42岁，高大儒雅。',
  '晏礼，28岁，商业巨鳄，内心冷淡。',
  '长远目标：不被炮灰掉',
  '（请直接按以上申报降临开演，无需追问。）',
].join('\n');

const OVERVIEW = [
  '┌ 镜瞳·世界观总览 ─────────',
  '① 时代与背景：2026年盛夏的北京市。',
  '③ 权力与势力：老牌政商楚家由楚律维掌舵稳控大局；章家作为附庸谋求通过联姻捆绑楚家；晏氏资本冷眼旁观。',
  '└────────────────',
].join('\n');

describe('问卷深建档', () => {
  it('主角稳定人设入档:性格/背景/关系定位', () => {
    const scan = scanJingtong([msg(QUESTIONNAIRE)]);
    const qp = scan.questionnaireProtagonist;
    expect(qp.gender).toBe('女');
    expect(qp.identity).toBe('右位');
    expect(qp.personality).toContain('装可怜');
    expect(qp.background).toContain('家境：贫穷');
    expect(qp.background).toContain('孤儿院');
  });

  it('长远目标与秘密成为计划/悬念种子,秘密条目拼入知情人', () => {
    const scan = scanJingtong([msg(QUESTIONNAIRE)]);
    expect(scan.questionnaireProtagonist.goals).toEqual(['不被炮灰掉']);
    expect(scan.questionnaireProtagonist.secrets).toHaveLength(3);
    expect(scan.questionnaireProtagonist.secrets?.[0]).toContain('楚律维');
    expect(scan.questionnaireProtagonist.secrets?.[0]).toContain('只有院长知道');
  });

  it('种子在重放层生效:deriveMemory 的 plans 含问卷目标(计划)与秘密(悬念)', () => {
    const mem = deriveMemory([msg(QUESTIONNAIRE)]);
    const goal = mem.plans.find(p => p.id === 'plan:qs:goal:0');
    expect(goal?.kind).toBe('plan');
    expect(goal?.content).toBe('不被炮灰掉');
    const secret = mem.plans.find(p => p.id === 'plan:qs:secret:0');
    expect(secret?.kind).toBe('suspense');
  });

  it('种子的 remove 可在后续楼层生效(不复活)', () => {
    const m1 = msg(QUESTIONNAIRE);
    const m2 = msg('后续剧情。');
    // 手动删除写入叶子 delta(模拟 appendOpToLatestLeaf 的产物;叶子需 id+delta 才被重放)
    m2.extra = { bbs_leaf: { id: 'test-leaf-2', delta: { plans: { remove: ['plan:qs:secret:0'] } } } } as STMessage['extra'];
    const mem = deriveMemory([m1, m2]);
    expect(mem.plans.some(p => p.id === 'plan:qs:secret:0')).toBe(false);
    expect(mem.plans.some(p => p.id === 'plan:qs:secret:1')).toBe(true); // 其余种子保留
  });

  it('关系字段抽真名:恋人=楚奕、朋友=林薇;无/泛称不建空壳卡', () => {
    const scan = scanJingtong([msg(QUESTIONNAIRE)]);
    const names = scan.questionnaireNpcs.map(n => n.name);
    expect(names).toContain('楚奕');
    expect(names).toContain('林薇');
    expect(names).not.toContain('父母');
    expect(names).not.toContain('兄弟姐妹');
    expect(names).not.toContain('社交圈');
    const lover = scan.questionnaireNpcs.find(n => n.name === '楚奕');
    expect(lover?.relation).toBe('恋人');
    expect(lover?.desc).toContain('男朋友');
  });

  it('势力种子短名提取:整句转描述,名=楚家/章家/晏氏', () => {
    const scan = scanJingtong([msg(OVERVIEW)]);
    expect(scan.factions.map(f => f.name)).toEqual(['楚家', '章家', '晏氏']);
    expect(scan.factions[0].desc).toContain('掌舵');
  });

  it('势力种子:顿号枚举的多派系拆成各势力,不再整句卡成一条(「三方博弈」集体名舍弃)', () => {
    const scan = scanJingtong([msg('┌ 镜瞳·世界观总览 ─────────\n③ 权力与势力：三方博弈——陆家为代表的军旅铁血建制派、以陆淮舟背后商贾巨富为首的资本新贵、以及以象牙塔学术权威与名校圈子构建的文化资本派。\n└────────────────')]);
    expect(scan.factions.map(f => f.name)).toEqual(['军旅铁血建制派', '资本新贵', '文化资本派']);
    expect(scan.factions[0].desc).toContain('陆家为代表');
    expect(scan.factions[1].desc).toContain('陆淮舟');
  });

  it('势力种子:罗列权柄的顿号不误拆(单一势力的描述句仍是一条)', () => {
    const scan = scanJingtong([msg('┌ 镜瞳·世界观总览 ─────────\n③ 权力与势力：军务委员会掌管军费、人事与后勤。\n└────────────────')]);
    expect(scan.factions).toHaveLength(1);
    expect(scan.factions[0].name).toBe('军务委员会');
    expect(scan.factions[0].desc).toContain('掌管');
  });

  it('势力种子:无组织后缀的「人带势力」写法走领袖称谓兜底(地下世界黑道头子)', () => {
    const ov = [
      '┌ 镜瞳·世界观总览 ─────────',
      '③ 权力与势力：老牌政商楚家由楚律维掌舵稳控大局；陆沉洲32岁，中意混血，英俊霸气，地下世界黑道头子，武力天花板级别人物，身高腿长气场超强，实则重情重义。',
    ].join('\n');
    const scan = scanJingtong([msg(ov)]);
    const lu = scan.factions.find(f => f.name.includes('黑道'));
    expect(lu?.name).toBe('地下世界黑道');
    expect(lu?.desc).toContain('陆沉洲');
    // 短名路径不受影响:带后缀的条目仍走「家」抽取
    expect(scan.factions.some(f => f.name === '楚家')).toBe(true);
  });

  it('问卷备注段整段入缓存(含多行人物小传)', () => {
    const scan = scanJingtong([msg(QUESTIONNAIRE)]);
    expect(scan.notes).toContain('楚律维，42岁'.replace('楚律维，42岁', '42岁'));
    expect(scan.notes).toContain('商业巨鳄');
    expect(scan.notes).not.toContain('长远目标');
  });

  it('问卷备注手动覆盖:非 null 覆盖楼层扫描结果,null 还原楼层原文', () => {
    const m1 = msg(QUESTIONNAIRE);
    const m2 = msg('后续剧情。');
    m2.extra = { bbs_leaf: { id: 'leaf-notes-1', delta: { jingtong: { notes: '手填:宋鹤年是宋家家主。' } } } } as STMessage['extra'];
    const m3 = msg('再后文。');
    m3.extra = { bbs_leaf: { id: 'leaf-notes-2', delta: { jingtong: { notes: null } } } } as STMessage['extra'];

    // 覆盖层在 store.recomputeDerived 里生效(与总览同款),需要按聊天上下文重算一次
    const spy = vi.spyOn(context, 'getContext');
    Object.assign(memory, createEmptyMemory());

    spy.mockReturnValue({ chat: [m1, m2], getCurrentChatId: () => 'notes-override' } as STContext);
    recomputeDerived();
    expect(memory.questionnaireNotes).toBe('手填:宋鹤年是宋家家主。');

    spy.mockReturnValue({ chat: [m1, m2, m3], getCurrentChatId: () => 'notes-override' } as STContext);
    recomputeDerived();
    expect(memory.questionnaireNotes).toContain('商业巨鳄');

    spy.mockRestore();
  });
});

const PROFILE = [
  '┌ 镜瞳·深度档案 ─────────',
  '姓名：周砚清',
  '职业：自由插画师',
  '└────────────────',
].join('\n');

describe('拍摄阶段(已推荐/已拍摄/已撤出/已二次拍摄/已二次撤出)', () => {
  function op(mes: string, remove: string[]): STMessage {
    const m = msg(mes);
    m.extra = { bbs_leaf: { id: `stage-${Math.random().toString(36).slice(2)}`, delta: { jingtong: { remove } } } } as STMessage['extra'];
    return m;
  }
  function calc(chat: STMessage[]): void {
    vi.spyOn(context, 'getContext').mockReturnValue({ chat, getCurrentChatId: () => 'stage-test' } as unknown as STContext);
    Object.assign(memory, createEmptyMemory());
    recomputeDerived();
  }

  it('拍过=已拍摄;反复重拍(无撤出)不升级;撤出=已撤出且档案消失', () => {
    calc([msg(PROFILE), msg('剧情。'), msg(PROFILE)]);
    expect(memory.profileStages.get('周砚清')).toBe('shot');
    expect(memory.deepProfiles.some(p => p.name === '周砚清')).toBe(true);

    calc([msg(PROFILE), op('剧情。', ['周砚清']), msg('后文。')]);
    expect(memory.profileStages.get('周砚清')).toBe('withdrawn');
    expect(memory.deepProfiles.some(p => p.name === '周砚清')).toBe(false);
  });

  it('撤出后再拍=已二次拍摄,档案恢复;再撤=已二次撤出', () => {
    calc([msg(PROFILE), op('剧情。', ['周砚清']), msg(PROFILE), op('后文。', ['周砚清'])]);
    expect(memory.profileStages.get('周砚清')).toBe('rewithdrawn');
    expect(memory.deepProfiles.some(p => p.name === '周砚清')).toBe(false);

    calc([msg(PROFILE), op('剧情。', ['周砚清']), msg(PROFILE)]);
    expect(memory.profileStages.get('周砚清')).toBe('reshot');
    expect(memory.deepProfiles.some(p => p.name === '周砚清')).toBe(true);
  });

  it('同楼先拍后撤:撤出赢(档案仍被压掉)', () => {
    calc([msg(PROFILE), op(PROFILE, ['周砚清'])]);
    expect(memory.profileStages.get('周砚清')).toBe('withdrawn');
    expect(memory.deepProfiles.some(p => p.name === '周砚清')).toBe(false);
  });

  it('手动编辑覆盖仍生效;旧墓碑语义改为楼层序:删除楼层之前的重复拍摄不受影响', () => {
    const m2 = msg('剧情。');
    m2.extra = {
      bbs_leaf: { id: 'stage-edit', delta: { jingtong: { update: [{ from: '周砚清', text: '职业：画廊主理人' }] } } },
    } as STMessage['extra'];
    calc([msg(PROFILE), m2]);
    expect(memory.deepProfiles.find(p => p.name === '周砚清')?.text).toContain('画廊主理人');
    expect(memory.profileStages.get('周砚清')).toBe('shot');
  });
});

const RECO = [
  '【镜瞳 · 系统推荐】',
  '为你检索到3位对口候选：',
  '1. 林晚晴 · 26岁 · 美术馆策展人 · 未婚 —— 理由：美术馆新展与主角的画室有合作项目。对{{user}}印象：无 ｜ 偏好：艺术共鸣优先。',
  '2. 朱利安·凡斯 · 25岁 · 律师 · 未婚 —— 理由：手头的遗产案与主角家族企业有关。对{{user}}印象：无 ｜ 偏好：社会硬条件。',
  '3. 路之，字云帆 · 三十岁 · 书院先生 · 已婚 —— 理由：书院讲席与主角的学业线相交。对{{user}}印象：无 ｜ 偏好：剧情牵引。',
  '（推荐只是建议，你可以完全无视，自己随便拍。）',
].join('\n');

describe('镜瞳系统推荐(候选进名册 + 已推荐阶段)', () => {
  function calc(chat: STMessage[]): void {
    vi.spyOn(context, 'getContext').mockReturnValue({ chat, getCurrentChatId: () => 'reco-test' } as unknown as STContext);
    Object.assign(memory, createEmptyMemory());
    recomputeDerived();
  }
  function leaf(mes: string, delta: Record<string, unknown>): STMessage {
    const m = msg(mes);
    m.extra = { bbs_leaf: { id: `reco-${Math.random().toString(36).slice(2)}`, delta } } as STMessage['extra'];
    return m;
  }

  it('条目解析:译名「·」与含逗号名不被切坏,候选进名册标「镜瞳推荐」且阶段=已推荐', () => {
    calc([msg(RECO)]);
    expect(scanJingtong([msg(RECO)]).recommends.map(r => r.name)).toEqual(['林晚晴', '朱利安·凡斯', '路之，字云帆']);
    const names = memory.npcs.map(n => n.name);
    expect(names).toContain('林晚晴');
    expect(names).toContain('朱利安·凡斯');
    expect(names).toContain('路之，字云帆');
    expect(memory.npcs.find(n => n.name === '朱利安·凡斯')?.relation).toBe('镜瞳推荐');
    expect(memory.npcs.find(n => n.name === '朱利安·凡斯')?.desc).toContain('遗产案');
    expect(memory.profileStages.get('朱利安·凡斯')).toBe('recommended');
  });

  it('普通剧情角色(摘要捕捉,无镜瞳记录)没有阶段,不再人人顶着「已推荐」', () => {
    const m = leaf('剧情。', { npcs: { add: [{ name: '路人甲', relation: '店员' }] } });
    calc([m, msg(RECO)]);
    expect(memory.npcs.some(n => n.name === '路人甲')).toBe(true);
    expect(memory.profileStages.get('路人甲')).toBeUndefined();
  });

  it('推荐过的人后来被拍:阶段流转成已拍摄;同名不重复建卡', () => {
    const profileLin = [
      '┌ 镜瞳·深度档案 ─────────',
      '姓名：林晚晴',
      '职业：美术馆策展人',
      '└────────────────',
    ].join('\n');
    calc([msg(RECO), msg(profileLin)]);
    expect(memory.profileStages.get('林晚晴')).toBe('shot');
    expect(memory.npcs.filter(n => n.name === '林晚晴')).toHaveLength(1);
  });

  it('手动删掉的候选不复活(delta.npcs.remove 墓碑)', () => {
    const m = leaf('删除。', { npcs: { remove: ['朱利安·凡斯'] } });
    calc([msg(RECO), m]);
    expect(memory.npcs.some(n => n.name === '朱利安·凡斯')).toBe(false);
  });

  it('手动阶段标签:压过自动派生,none 隐藏,后写覆盖先写', () => {
    const hide = leaf('手动隐藏。', { jingtong: { stage: [{ name: '林晚晴', stage: 'none' }] } });
    const manual = leaf('手动标拍。', { jingtong: { stage: [{ name: '林晚晴', stage: 'shot' }, { name: '路人乙', stage: 'withdrawn' }] } });
    calc([msg(RECO), hide]);
    expect(memory.profileStages.get('林晚晴')).toBeUndefined();
    calc([msg(RECO), hide, manual]);
    expect(memory.profileStages.get('林晚晴')).toBe('shot'); // 后写覆盖先写
    expect(memory.profileStages.get('路人乙')).toBe('withdrawn'); // 无镜瞳记录也能手动贴标
  });
});
