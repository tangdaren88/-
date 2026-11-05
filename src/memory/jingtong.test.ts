/**
 * 镜瞳问卷深建档回归(v1.5.0):
 *  - 问卷主角稳定人设(personality/background/identity)入档
 *  - 长远目标/秘密 → 计划/悬念种子(可被手动 resolve/remove,不复活)
 *  - 问卷关系字段抽真名(不再产「父母/朋友」空壳卡)
 *  - 势力种子短名提取(不再整句卡名)
 *  - 问卷备注段入派生缓存
 */
import { describe, expect, it } from 'vitest';
import { deriveMemory } from './apply';
import { scanJingtong } from './jingtong';
import type { STMessage } from '@/st/context';

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
});
