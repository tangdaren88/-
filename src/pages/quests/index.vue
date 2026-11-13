<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import BbsSelect from '@/components/BbsSelect.vue';
import ModalMask from '@/components/ModalMask.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import SummaryOnlyNotice from '@/components/SummaryOnlyNotice.vue';
import { clearQuests, editQuest, importQuestOutline, removeQuest, upsertQuest } from '@/memory/apply';
import { buildQuestDraft } from '@/memory/inject';
import { parseQuestOutline } from '@/memory/questOutline';
import { apiSettings } from '@/api/settings';
import { derivedMeta, memory } from '@/memory/store';
import { closeBook } from '@/state/ui';
import type { MemQuest, QuestStatus } from '@/memory/types';
import { appendChatInput, getContext } from '@/st/context';
import { toast } from '@/st/toast';
import { computed, ref } from 'vue';

// 任务是从叶子摘要重放出的派生数据,手动操作写入「最新一条有效叶子」;无有效叶子时无处挂载。
const hasLeaf = computed(() => derivedMeta.hasLeaf);

/* —— 进行中任务:主线在前(各按创建时间),已完结归档按最近更新倒序 —— */
const activeQuests = computed(() => memory.quests.filter(q => q.status === 'active'));
const mainCount = computed(() => activeQuests.value.filter(q => q.kind === 'main').length);
const sideCount = computed(() => activeQuests.value.filter(q => q.kind === 'side').length);
const archivedQuests = computed(() =>
  memory.quests
    .filter(q => q.status !== 'active')
    .sort((a, b) => b.updatedAt - a.updatedAt),
);

/* —— 子任务树:扁平任务按 parent 组装成嵌套树再展平成行,排版与势力/场景页同构 —— */
const qkey = (s: string): string => s.trim().toLowerCase();
interface QuestNode extends MemQuest {
  children: QuestNode[];
}
/** 扁平 → 树(parent 存名字;父悬空/被删/已归档视作顶级,数据不动) */
const questTree = computed<QuestNode[]>(() => {
  const list = activeQuests.value;
  const names = new Set(list.map(q => qkey(q.name)));
  const byParent = new Map<string, QuestNode[]>();
  const tops: QuestNode[] = [];
  for (const q of list) {
    const node: QuestNode = { ...q, children: [] };
    const p = (q.parent ?? '').trim();
    if (p && names.has(qkey(p))) {
      const arr = byParent.get(qkey(p));
      if (arr) arr.push(node);
      else byParent.set(qkey(p), [node]);
    } else {
      tops.push(node); // 无父/父悬空 = 顶级
    }
  }
  const attach = (nodes: QuestNode[]): void => {
    for (const n of nodes) {
      n.children = byParent.get(qkey(n.name)) ?? [];
      attach(n.children);
    }
  };
  attach(tops);
  return tops;
});

interface QuestRow {
  q: QuestNode;
  depth: number;
  hasChildren: boolean;
  isCollapsed: boolean;
}
function flattenQuestTree(nodes: QuestNode[], depth: number, out: QuestRow[]): void {
  for (const n of nodes) {
    const hasChildren = n.children.length > 0;
    const isCollapsed = hasChildren && collapsedNodes.value.has(n.id);
    out.push({ q: n, depth, hasChildren, isCollapsed });
    if (!isCollapsed) flattenQuestTree(n.children, depth + 1, out);
  }
}
const mainRows = computed<QuestRow[]>(() => {
  const out: QuestRow[] = [];
  flattenQuestTree(questTree.value.filter(n => n.kind === 'main'), 0, out);
  return out;
});
const sideRows = computed<QuestRow[]>(() => {
  const out: QuestRow[] = [];
  flattenQuestTree(questTree.value.filter(n => n.kind === 'side'), 0, out);
  return out;
});

/* —— 单个任务的折叠:有子任务才出现箭头,点击收起/展开其整棵子树;
      状态按聊天分桶存 localStorage(与势力树同款,默认全展开) —— */
const NODE_COLLAPSE_KEY = 'bbs.quests.collapsedNodes.v1';
function loadCollapsedNodes(): Set<string> {
  try {
    const all = JSON.parse(localStorage.getItem(NODE_COLLAPSE_KEY) || '{}');
    const arr = all[chatKey()];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}
const collapsedNodes = ref<Set<string>>(loadCollapsedNodes());
function persistCollapsedNodes() {
  try {
    const all = JSON.parse(localStorage.getItem(NODE_COLLAPSE_KEY) || '{}');
    all[chatKey()] = [...collapsedNodes.value];
    localStorage.setItem(NODE_COLLAPSE_KEY, JSON.stringify(all));
  } catch {
    /* localStorage 不可用时仅本次会话生效 */
  }
}
function toggleNodeCollapse(id: string) {
  const next = new Set(collapsedNodes.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsedNodes.value = next; // 换引用触发响应式
  persistCollapsedNodes();
}
// 折叠时展示的后代任务数(整棵子树,按 parent 链)
function subCount(node: QuestNode): number {
  return node.children.reduce((acc, c) => acc + 1 + subCount(c), 0);
}

/* —— 分组折叠:纯本机 UI 态,按聊天分桶存 localStorage(与势力页折叠同款) —— */
const QUESTS_COLLAPSE_KEY = 'bbs.quests.collapsed.v1';
function chatKey(): string {
  return getContext()?.getCurrentChatId?.() || '_';
}
interface GroupCollapse {
  main: boolean;
  side: boolean;
  archive: boolean;
}
function loadCollapse(): GroupCollapse {
  try {
    const all = JSON.parse(localStorage.getItem(QUESTS_COLLAPSE_KEY) || '{}');
    const v = all[chatKey()];
    return { main: v?.main === true, side: v?.side === true, archive: v?.archive === true };
  } catch {
    return { main: false, side: false, archive: false };
  }
}
const collapsed = ref<GroupCollapse>(loadCollapse());
function persistCollapse() {
  try {
    const all = JSON.parse(localStorage.getItem(QUESTS_COLLAPSE_KEY) || '{}');
    all[chatKey()] = collapsed.value;
    localStorage.setItem(QUESTS_COLLAPSE_KEY, JSON.stringify(all));
  } catch {
    /* localStorage 不可用时仅本次会话生效 */
  }
}
function toggleCollapse(k: keyof GroupCollapse) {
  collapsed.value = { ...collapsed.value, [k]: !collapsed.value[k] };
  persistCollapse();
}

/* —— 编辑弹窗 —— */
interface QuestDraft {
  oldName: string; // 空=新增
  name: string;
  kind: 'main' | 'side';
  desc: string;
  progress: string;
  status: QuestStatus;
  faction: string;
  parent: string;
}
const questEditing = ref<QuestDraft | null>(null);
const questRemoving = ref<MemQuest | null>(null);

const STATUS_OPTIONS = [
  { value: 'active', label: '进行中' },
  { value: 'done', label: '已完成' },
  { value: 'failed', label: '已失败' },
];
/** 关联势力候选:现有全部势力 + 空选项 */
const questFactionOptions = computed(() => [
  { value: '', label: '(无关联势力)' },
  ...memory.factions.map(f => ({ value: f.name, label: f.name })),
]);
/** 父任务候选:全部现有任务,排除自己;防环:自己的子孙也不可选 */
const questParentOptions = computed(() => {
  const e = questEditing.value;
  const exclude = new Set<string>();
  if (e?.oldName) {
    exclude.add(qkey(e.oldName));
    const collect = (name: string): void => {
      for (const q of memory.quests) {
        if (qkey(q.parent ?? '') === qkey(name) && !exclude.has(qkey(q.name))) {
          exclude.add(qkey(q.name));
          collect(q.name);
        }
      }
    };
    collect(e.oldName);
  }
  return [
    { value: '', label: '(无 — 顶级任务)' },
    ...memory.quests.filter(q => !exclude.has(qkey(q.name))).map(q => ({ value: q.name, label: q.name })),
  ];
});

function openQuestAdd(kind: 'main' | 'side' = 'main', parent = '') {
  if (!hasLeaf.value) {
    toast('没有可写入的摘要楼层(先补摘一次)', 'error');
    return;
  }
  questEditing.value = { oldName: '', name: '', kind, desc: '', progress: '', status: 'active', faction: '', parent };
}
function openQuestEdit(q: MemQuest) {
  questEditing.value = {
    oldName: q.name,
    name: q.name,
    kind: q.kind,
    desc: q.desc ?? '',
    progress: q.progress ?? '',
    status: q.status,
    faction: q.faction ?? '',
    parent: q.parent ?? '',
  };
}
function cancelQuestEdit() {
  questEditing.value = null;
}
function saveQuestEdit() {
  const e = questEditing.value;
  if (!e || !e.name.trim()) return;
  const patch = {
    name: e.name.trim(),
    kind: e.kind,
    desc: e.desc,
    progress: e.progress,
    status: e.status,
    faction: e.faction,
    parent: e.parent,
  };
  // 新增走 editQuest 的 update 语义(不存在先建),一次 op 连 progress 一起写;但拒绝与现有任务重名
  if (!e.oldName && memory.quests.some(q => q.name.trim().toLowerCase() === patch.name.toLowerCase())) {
    toast('已有同名任务,直接编辑它即可', 'error');
    return;
  }
  const ok = editQuest(e.oldName || patch.name, patch);
  if (!ok) toast('没有可写入的摘要楼层(先补摘一次)', 'error');
  questEditing.value = null;
}
function confirmRemoveQuest() {
  if (questRemoving.value && !removeQuest(questRemoving.value.name)) toast('没有可写入的摘要楼层(先补摘一次)', 'error');
  questRemoving.value = null;
}

/* —— 一键清除:主线/支线分组各一个按钮,该类进行中任务连整棵子任务树一起删 —— */
const questClearing = ref<'main' | 'side' | null>(null);
function confirmClearQuests() {
  const kind = questClearing.value;
  if (!kind) return;
  if (!clearQuests(kind)) toast('没有可写入的摘要楼层(先补摘一次)', 'error');
  questClearing.value = null;
}

/* —— 推进草稿:仿场景页「前往地点」,只生成草稿填输入框,不提前改记忆 —— */
const questDrafting = ref<MemQuest | null>(null);
function askQuestDraft(q: MemQuest) {
  questDrafting.value = q;
}
function confirmQuestDraft() {
  const q = questDrafting.value;
  if (!q) return;
  if (!appendChatInput(buildQuestDraft(q))) {
    toast('无法写入 ST 输入框', 'error');
    return;
  }
  questDrafting.value = null;
  closeBook();
  toast('任务推进草稿已填入输入框', 'success');
}

/* —— 批量导入:粘贴一段文本,按换行/顿号/逗号/分号等拆成一条条任务 —— */
const questImporting = ref<{ kind: 'main' | 'side'; text: string } | null>(null);
function openQuestImport(kind: 'main' | 'side') {
  if (!hasLeaf.value) {
    toast('没有可写入的摘要楼层(先补摘一次)', 'error');
    return;
  }
  questImporting.value = { kind, text: '' };
}
function cancelQuestImport() {
  questImporting.value = null;
}
function confirmQuestImport() {
  const e = questImporting.value;
  if (!e) return;
  // 换行/顿号/中英文逗号/分号/句号都当分隔符,整段文本拆成一条条任务名
  const parts = e.text.split(/[\r\n、,，;；。;]+/).map(s => s.trim()).filter(Boolean);
  if (!parts.length) {
    toast('没有可导入的任务名', 'error');
    return;
  }
  const exist = new Set(memory.quests.map(q => q.name.trim().toLowerCase()));
  let added = 0;
  let skipped = 0;
  for (const name of parts) {
    if (exist.has(name.toLowerCase())) {
      skipped++; // 与已有任务重名直接跳过,不打断整批
      continue;
    }
    exist.add(name.toLowerCase());
    if (!upsertQuest({ name, kind: e.kind })) {
      toast('没有可写入的摘要楼层(先补摘一次)', 'error');
      return;
    }
    added++;
  }
  if (added) toast(`已导入 ${added} 个${e.kind === 'main' ? '主线' : '支线'}任务${skipped ? `,跳过 ${skipped} 个重复` : ''}`);
  else toast('全部为重复任务名,未导入', 'error');
  questImporting.value = null;
}

/* —— 整本大纲导入:把 AI 拆好的「主线/支线 + 子任务」整段粘进来,一次建好整棵树 —— */
const outlineImporting = ref<string | null>(null); // null=弹窗关闭
const outlineParsed = computed(() => (outlineImporting.value ? parseQuestOutline(outlineImporting.value) : []));
const outlineParents = computed(() => outlineParsed.value.filter(q => !q.parent));
const outlineChildCount = computed(() => outlineParsed.value.filter(q => !!q.parent).length);
const outlineDupCount = computed(() => {
  const exist = new Set(memory.quests.map(q => q.name.trim().toLowerCase()));
  return outlineParsed.value.filter(q => exist.has(q.name.trim().toLowerCase())).length;
});

function openOutlineImport() {
  if (!hasLeaf.value) {
    toast('没有可写入的摘要楼层(先补摘一次)', 'error');
    return;
  }
  outlineImporting.value = '';
}
function cancelOutlineImport() {
  outlineImporting.value = null;
}
function confirmOutlineImport() {
  const list = outlineParsed.value;
  if (!list.length) {
    toast('没有识别到任务,检查一下格式', 'error');
    return;
  }
  // 与现有任务重名跳过(写入也是按名匹配);同批内重名只留第一条
  const exist = new Set(memory.quests.map(q => q.name.trim().toLowerCase()));
  const fresh = list.filter(q => {
    const k = q.name.trim().toLowerCase();
    if (exist.has(k)) return false;
    exist.add(k);
    return true;
  });
  const skipped = list.length - fresh.length;
  if (!fresh.length) {
    toast('全部与现有任务重名,未导入', 'error');
    outlineImporting.value = null;
    return;
  }
  if (!importQuestOutline(fresh)) {
    toast('没有可写入的摘要楼层(先补摘一次)', 'error');
    return;
  }
  const parents = fresh.filter(q => !q.parent).length;
  toast(`已导入 ${parents} 条任务、${fresh.length - parents} 个子任务${skipped ? `,跳过 ${skipped} 条重复` : ''}`);
  outlineImporting.value = null;
}
</script>

<template>
  <section class="bbs-page">
    <SummaryOnlyNotice />

    <div class="bbs-quests-wrap">
      <div v-if="memory.quests.length || hasLeaf">
        <!-- 整本大纲导入:最原始的一整段粘贴,自动拆成主线/支线 + 子任务树 -->
        <div class="bbs-quest-outline">
          <div class="bbs-quest-outline-head">
            <h2 class="bbs-faction-title">整本大纲</h2>
            <button class="bbs-btn bbs-btn-primary bbs-outline-btn" type="button" @click="openOutlineImport">
              <Icon name="download" /> 粘贴导入
            </button>
          </div>
          <p class="bbs-quest-outline-hint">
            把 AI 拆好的整本任务大纲整段粘进来(支持「主线任务A：任务名 / 描述：… / 子任务1：… / 支线任务B：任务名（主线任务A期间可接）」),自动拆成主线/支线及其子任务,「描述：」会写进任务的目标描述。
          </p>
        </div>

        <label class="bbs-quest-switch" title="任务系统总开关(与设置页「任务」开关同步)">
          <input v-model="apiSettings.injection.quests" type="checkbox" class="bbs-checkbox" />
          <span>
            自动捕捉任务
            <em>开启:随剧情摘要自动回报任务并注入主模型防目标线写丢。关闭:不再注入、摘要也不再捕捉任务(已有记录保留,重新打开即恢复);仍可手动增删改回看。</em>
          </span>
        </label>
        <p class="bbs-npc-mainhint">主线推动剧情的核心目标,支线是可接可不做的委托;随剧情自动捕捉演化,完成/失败后移入下方「已完结」归档(不再注入)。点 + 手动添加,点卡片上的 + 添加其子任务,点卡片上的 → 生成剧情推进草稿;分组标题右侧的垃圾桶可一键清空该类任务(含子任务)。</p>

        <!-- 主线 -->
        <div class="bbs-npc-group">
          <div class="bbs-npc-grouphead">
            <button
              class="bbs-fold-head"
              type="button"
              :aria-expanded="!collapsed.main"
              :title="collapsed.main ? '展开主线任务' : '收起主线任务'"
              @click="toggleCollapse('main')"
            >
              <Icon name="chevron" class="bbs-fold-caret" :class="{ 'is-collapsed': collapsed.main }" />
              <h2 class="bbs-faction-title">主线任务</h2>
              <span v-if="mainCount" class="bbs-fold-count">{{ mainCount }}</span>
            </button>
            <button class="bbs-add-mini" type="button" title="批量导入主线任务" @click="openQuestImport('main')"><Icon name="download" /></button>
            <button class="bbs-add-mini" type="button" title="添加主线任务" @click="openQuestAdd('main')"><Icon name="plus" /></button>
            <button v-if="mainCount" class="bbs-add-mini bbs-item-del" type="button" title="一键清除全部主线任务(含子任务)" @click="questClearing = 'main'"><Icon name="trash" /></button>
          </div>
          <div v-if="!collapsed.main" class="bbs-npc-list">
            <template v-if="mainRows.length">
              <!-- 行容器:轨道槽在卡片外侧(与势力/场景页同构),竖线跑在行背景里而不是卡内 -->
              <div v-for="row in mainRows" :key="row.q.id" class="bbs-quest-row">
                <span v-for="d in row.depth" :key="d" class="bbs-quest-rail" aria-hidden="true"></span>
                <article class="bbs-npc is-present" :class="{ 'is-child': row.depth > 0, 'is-side': row.q.kind === 'side' }">
                  <div class="bbs-npc-body">
                    <div class="bbs-npc-head">
                      <button
                        v-if="row.hasChildren"
                        class="bbs-quest-toggle"
                        :class="{ collapsed: row.isCollapsed }"
                        type="button"
                        :title="row.isCollapsed ? `展开 ${row.q.children.length} 个子任务` : '收起子任务'"
                        :aria-label="row.isCollapsed ? '展开子任务' : '收起子任务'"
                        @click.stop="toggleNodeCollapse(row.q.id)"
                      ><Icon name="chevron" /></button>
                      <span class="bbs-npc-name" :title="row.q.name">{{ row.q.name }}</span>
                      <span v-if="row.hasChildren && row.isCollapsed" class="bbs-quest-childcount" :title="`已收起 ${subCount(row.q)} 个子任务`">{{ subCount(row.q) }}</span>
                      <span v-if="row.depth > 0 && row.q.parent" class="bbs-npc-gender" :title="`子任务 · 隶属 ${row.q.parent}`">子任务</span>
                      <span class="bbs-npc-acts">
                        <button class="bbs-item-act" type="button" title="生成推进草稿" @click="askQuestDraft(row.q)"><Icon name="navigate" /></button>
                        <button class="bbs-item-act" type="button" :title="`在 ${row.q.name} 下添加子任务`" @click="openQuestAdd(row.q.kind, row.q.name)"><Icon name="plus" /></button>
                        <button class="bbs-item-act" type="button" title="编辑" @click="openQuestEdit(row.q)"><Icon name="edit" /></button>
                        <button class="bbs-item-act bbs-item-del" type="button" title="删除" @click="questRemoving = row.q"><Icon name="trash" /></button>
                      </span>
                    </div>
                    <dl v-if="row.q.desc || row.q.progress || row.q.faction" class="bbs-npc-fields">
                      <div v-if="row.q.desc" class="bbs-npc-field f-desc"><dt title="做什么 / 为什么 / 做到什么程度算成">目标</dt><dd>{{ row.q.desc }}</dd></div>
                      <div v-if="row.q.progress" class="bbs-npc-field"><dt>进展</dt><dd>{{ row.q.progress }}</dd></div>
                      <div v-if="row.q.faction" class="bbs-npc-field"><dt>势力</dt><dd>{{ row.q.faction }}</dd></div>
                    </dl>
                    <p v-else class="bbs-npc-mainhint">尚无描述 —— 编辑可补充目标与当前进展。</p>
                  </div>
                </article>
              </div>
            </template>
            <p v-else class="bbs-npc-mainhint">暂无进行中的主线任务;摘要出现新任务线后会自动记录。</p>
          </div>
        </div>

        <!-- 支线 -->
        <div class="bbs-npc-group">
          <div class="bbs-npc-grouphead">
            <button
              class="bbs-fold-head"
              type="button"
              :aria-expanded="!collapsed.side"
              :title="collapsed.side ? '展开支线任务' : '收起支线任务'"
              @click="toggleCollapse('side')"
            >
              <Icon name="chevron" class="bbs-fold-caret" :class="{ 'is-collapsed': collapsed.side }" />
              <h2 class="bbs-faction-title">支线任务</h2>
              <span v-if="sideCount" class="bbs-fold-count">{{ sideCount }}</span>
            </button>
            <button class="bbs-add-mini" type="button" title="批量导入支线任务" @click="openQuestImport('side')"><Icon name="download" /></button>
            <button class="bbs-add-mini" type="button" title="添加支线任务" @click="openQuestAdd('side')"><Icon name="plus" /></button>
            <button v-if="sideCount" class="bbs-add-mini bbs-item-del" type="button" title="一键清除全部支线任务(含子任务)" @click="questClearing = 'side'"><Icon name="trash" /></button>
          </div>
          <div v-if="!collapsed.side" class="bbs-npc-list">
            <template v-if="sideRows.length">
              <div v-for="row in sideRows" :key="row.q.id" class="bbs-quest-row">
                <span v-for="d in row.depth" :key="d" class="bbs-quest-rail" aria-hidden="true"></span>
                <article class="bbs-npc is-present is-side" :class="{ 'is-child': row.depth > 0 }">
                  <div class="bbs-npc-body">
                    <div class="bbs-npc-head">
                      <button
                        v-if="row.hasChildren"
                        class="bbs-quest-toggle"
                        :class="{ collapsed: row.isCollapsed }"
                        type="button"
                        :title="row.isCollapsed ? `展开 ${row.q.children.length} 个子任务` : '收起子任务'"
                        :aria-label="row.isCollapsed ? '展开子任务' : '收起子任务'"
                        @click.stop="toggleNodeCollapse(row.q.id)"
                      ><Icon name="chevron" /></button>
                      <span class="bbs-npc-name" :title="row.q.name">{{ row.q.name }}</span>
                      <span v-if="row.hasChildren && row.isCollapsed" class="bbs-quest-childcount" :title="`已收起 ${subCount(row.q)} 个子任务`">{{ subCount(row.q) }}</span>
                      <span v-if="row.depth > 0 && row.q.parent" class="bbs-npc-gender" :title="`子任务 · 隶属 ${row.q.parent}`">子任务</span>
                      <span class="bbs-npc-acts">
                        <button class="bbs-item-act" type="button" title="生成推进草稿" @click="askQuestDraft(row.q)"><Icon name="navigate" /></button>
                        <button class="bbs-item-act" type="button" :title="`在 ${row.q.name} 下添加子任务`" @click="openQuestAdd(row.q.kind, row.q.name)"><Icon name="plus" /></button>
                        <button class="bbs-item-act" type="button" title="编辑" @click="openQuestEdit(row.q)"><Icon name="edit" /></button>
                        <button class="bbs-item-act bbs-item-del" type="button" title="删除" @click="questRemoving = row.q"><Icon name="trash" /></button>
                      </span>
                    </div>
                    <dl v-if="row.q.desc || row.q.progress || row.q.faction" class="bbs-npc-fields">
                      <div v-if="row.q.desc" class="bbs-npc-field f-desc"><dt title="做什么 / 为什么 / 做到什么程度算成">目标</dt><dd>{{ row.q.desc }}</dd></div>
                      <div v-if="row.q.progress" class="bbs-npc-field"><dt>进展</dt><dd>{{ row.q.progress }}</dd></div>
                      <div v-if="row.q.faction" class="bbs-npc-field"><dt>势力</dt><dd>{{ row.q.faction }}</dd></div>
                    </dl>
                    <p v-else class="bbs-npc-mainhint">尚无描述 —— 编辑可补充目标与当前进展。</p>
                  </div>
                </article>
              </div>
            </template>
            <p v-else class="bbs-npc-mainhint">暂无进行中的支线任务;可点上方 + 手动接个委托。</p>
          </div>
        </div>

        <!-- 已完结归档:只回看不注入 -->
        <div v-if="archivedQuests.length" class="bbs-npc-group">
          <div class="bbs-npc-grouphead">
            <button
              class="bbs-fold-head"
              type="button"
              :aria-expanded="!collapsed.archive"
              :title="collapsed.archive ? '展开已完结任务' : '收起已完结任务'"
              @click="toggleCollapse('archive')"
            >
              <Icon name="chevron" class="bbs-fold-caret" :class="{ 'is-collapsed': collapsed.archive }" />
              <h2 class="bbs-faction-title">已完结</h2>
              <span class="bbs-fold-count">{{ archivedQuests.length }}</span>
            </button>
          </div>
          <div v-if="!collapsed.archive" class="bbs-npc-list">
            <article
              v-for="q in archivedQuests"
              :key="q.id"
              class="bbs-npc is-present is-archived"
              :class="`is-${q.status}`"
            >
              <div class="bbs-npc-body">
                <div class="bbs-npc-head">
                  <span class="bbs-npc-name" :title="q.name">{{ q.name }}</span>
                  <span class="bbs-quest-state" :class="q.status">{{ q.status === 'done' ? '已完成' : '已失败' }}</span>
                  <span v-if="q.finishedTime" class="bbs-npc-gender" :title="'故事内完结时间'">{{ q.finishedTime }}</span>
                  <span class="bbs-npc-acts">
                    <button class="bbs-item-act" type="button" title="生成推进草稿" @click="askQuestDraft(q)"><Icon name="navigate" /></button>
                    <button class="bbs-item-act" type="button" title="编辑(改回「进行中」可重新激活)" @click="openQuestEdit(q)"><Icon name="edit" /></button>
                    <button class="bbs-item-act bbs-item-del" type="button" title="删除" @click="questRemoving = q"><Icon name="trash" /></button>
                  </span>
                </div>
                <dl v-if="q.desc || q.progress || q.faction" class="bbs-npc-fields">
                  <div v-if="q.desc" class="bbs-npc-field"><dt>目标</dt><dd>{{ q.desc }}</dd></div>
                  <div v-if="q.progress" class="bbs-npc-field"><dt>结局</dt><dd>{{ q.progress }}</dd></div>
                  <div v-if="q.faction" class="bbs-npc-field"><dt>势力</dt><dd>{{ q.faction }}</dd></div>
                </dl>
              </div>
            </article>
          </div>
        </div>
      </div>

      <!-- 整本大纲导入弹窗:一整段粘贴 + 实时预览解析结果 -->
      <ModalMask :open="outlineImporting !== null" @close="cancelOutlineImport">
        <div v-if="outlineImporting !== null" class="bbs-modal" role="dialog" aria-modal="true" aria-label="整本大纲导入">
          <header class="bbs-modal-head">
            <span class="bbs-modal-title">整本大纲导入</span>
            <button class="bbs-item-act" type="button" title="关闭" @click="cancelOutlineImport"><Icon name="close" /></button>
          </header>
          <label class="bbs-modal-field">
            <span class="bbs-modal-label">任务大纲原文(直接粘贴,不用先整理格式)</span>
            <textarea
              v-model="outlineImporting"
              class="bbs-input bbs-modal-textarea"
              rows="10"
              placeholder="主线任务A：九龙拉棺·告别地球&#10;描述：带全班同学经历九龙拉棺之变并保住性命&#10;子任务1：夜登泰山赴同学聚会&#10;描述：与老同学重聚，一同夜登泰山&#10;支线任务B：九龙拉棺之谜（主线任务A进行期间可接）&#10;描述：追查青铜古棺的来历"
            ></textarea>
          </label>
          <div v-if="outlineParsed.length" class="bbs-outline-preview">
            <p class="bbs-outline-sum">
              识别到 {{ outlineParents.length }} 条任务、{{ outlineChildCount }} 个子任务<template v-if="outlineDupCount">,其中 {{ outlineDupCount }} 条与现有任务重名将跳过</template>
            </p>
            <ul class="bbs-outline-list">
              <li v-for="(q, i) in outlineParsed.slice(0, 12)" :key="i" :class="{ 'is-child': !!q.parent }" :title="q.desc || ''">
                <span class="bbs-outline-kind" :class="q.kind">{{ q.kind === 'main' ? '主线' : '支线' }}</span>
                <span class="bbs-outline-name">{{ q.name }}</span>
                <em v-if="q.desc" class="bbs-outline-parent">含描述</em>
                <em v-if="q.parent" class="bbs-outline-parent">隶属 {{ q.parent }}</em>
              </li>
            </ul>
            <p v-if="outlineParsed.length > 12" class="bbs-outline-sum">…另有 {{ outlineParsed.length - 12 }} 条,导入后可在列表里查看</p>
          </div>
          <p v-else class="bbs-import-hint">还没识别到任务:需要出现「主线任务」「支线任务」这类标题,或逐行写任务名。</p>
          <footer class="bbs-modal-foot">
            <button class="bbs-btn" type="button" @click="cancelOutlineImport">取消</button>
            <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!outlineParsed.length" @click="confirmOutlineImport">导入</button>
          </footer>
        </div>
      </ModalMask>

      <!-- 任务 添加/编辑弹窗:名/类型/目标描述/当前进展/关联势力/状态 -->
      <ModalMask :open="!!questEditing" @close="cancelQuestEdit">
        <div v-if="questEditing" class="bbs-modal" role="dialog" aria-modal="true" aria-label="编辑任务">
          <header class="bbs-modal-head">
            <span class="bbs-modal-title">{{ questEditing.oldName ? '编辑任务' : '添加任务' }}</span>
            <button class="bbs-item-act" type="button" title="关闭" @click="cancelQuestEdit"><Icon name="close" /></button>
          </header>
          <label class="bbs-modal-field">
            <span class="bbs-modal-label">任务名</span>
            <input v-model="questEditing.name" class="bbs-input" type="text" placeholder="如:查明图书馆密室的来历" />
          </label>
          <div class="bbs-modal-field">
            <span class="bbs-modal-label">父任务(留空 = 顶级;子任务像势力/场景一样挂在其下)</span>
            <BbsSelect v-model="questEditing.parent" :options="questParentOptions" aria-label="父任务" />
          </div>
          <label class="bbs-modal-field">
            <span class="bbs-modal-label">类型(主线=推动剧情的核心目标;支线=可接可不做的委托)</span>
            <BbsSelect v-model="questEditing.kind" :options="[{ value: 'main', label: '主线' }, { value: 'side', label: '支线' }]" aria-label="任务类型" />
          </label>
          <label class="bbs-modal-field">
            <span class="bbs-modal-label">目标描述(做什么 / 为什么 / 做到什么程度算成)</span>
            <textarea v-model="questEditing.desc" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:找到校长失踪前留下的最后一封信"></textarea>
          </label>
          <label class="bbs-modal-field">
            <span class="bbs-modal-label">当前进展(留空 = 暂无新进展;AI 会随剧情更新)</span>
            <textarea v-model="questEditing.progress" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:已从旧档案里翻出一张泛黄的地图"></textarea>
          </label>
          <label class="bbs-modal-field">
            <span class="bbs-modal-label">关联势力(支线委托方,可选)</span>
            <BbsSelect v-model="questEditing.faction" :options="questFactionOptions" aria-label="关联势力" />
          </label>
          <label class="bbs-modal-field">
            <span class="bbs-modal-label">状态(完成/失败即归档,不再注入)</span>
            <BbsSelect v-model="questEditing.status" :options="STATUS_OPTIONS" aria-label="任务状态" />
          </label>
          <footer class="bbs-modal-foot">
            <button class="bbs-btn" type="button" @click="cancelQuestEdit">取消</button>
            <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!questEditing.name.trim()" @click="saveQuestEdit">保存</button>
          </footer>
        </div>
      </ModalMask>

      <!-- 任务 批量导入弹窗:粘贴一段文本按分隔符拆成一条条任务 -->
      <ModalMask :open="!!questImporting" @close="cancelQuestImport">
        <div v-if="questImporting" class="bbs-modal" role="dialog" aria-modal="true" aria-label="批量导入任务">
          <header class="bbs-modal-head">
            <span class="bbs-modal-title">批量导入{{ questImporting.kind === 'main' ? '主线' : '支线' }}任务</span>
            <button class="bbs-item-act" type="button" title="关闭" @click="cancelQuestImport"><Icon name="close" /></button>
          </header>
          <label class="bbs-modal-field">
            <span class="bbs-modal-label">任务列表(每行一个;顿号、逗号、分号、句号分隔也会拆开)</span>
            <textarea
              v-model="questImporting.text"
              v-autosize
              class="bbs-input bbs-modal-textarea bbs-modal-autogrow"
              rows="4"
              placeholder="如:&#10;吃饭&#10;喝水&#10;睡觉&#10;或: 吃饭、喝水、睡觉"
            ></textarea>
          </label>
          <p class="bbs-import-hint">拆分后的每条会作为独立任务导入,重复的任务名自动跳过;导入后可逐个编辑补充目标描述、进展与关联势力。</p>
          <footer class="bbs-modal-foot">
            <button class="bbs-btn" type="button" @click="cancelQuestImport">取消</button>
            <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!questImporting.text.trim()" @click="confirmQuestImport">导入</button>
          </footer>
        </div>
      </ModalMask>

      <ConfirmDialog
        :open="!!questRemoving"
        title="删除任务"
        tone="danger"
        confirm-text="删除"
        confirm-icon="trash"
        @update:open="v => { if (!v) questRemoving = null; }"
        @confirm="confirmRemoveQuest"
        @cancel="questRemoving = null"
      >
        删除任务「{{ questRemoving?.name }}」?其子任务不会被连带删除,会自动升为顶级(可再编辑改指其他父级)。删除会写入最新摘要,此后不会再被捕捉恢复。若只是不想再跟踪,建议改成「已完成/已失败」归档保留。
      </ConfirmDialog>

      <ConfirmDialog
        :open="!!questClearing"
        title="一键清除任务"
        tone="danger"
        confirm-text="全部清除"
        confirm-icon="trash"
        @update:open="v => { if (!v) questClearing = null; }"
        @confirm="confirmClearQuests"
        @cancel="questClearing = null"
      >
        清除全部{{ questClearing === 'side' ? '支线' : '主线' }}任务?每棵顶级任务连其下所有子任务整树删除;已完结归档的任务保留。清除会写入最新摘要,此后不会再被捕捉恢复。
      </ConfirmDialog>

      <ConfirmDialog
        :open="!!questDrafting"
        title="生成推进草稿"
        confirm-text="填入输入框"
        confirm-icon="navigate"
        @update:open="v => { if (!v) questDrafting = null; }"
        @confirm="confirmQuestDraft"
        @cancel="questDrafting = null"
      >
        按任务「{{ questDrafting?.name }}」的当前状态生成一段剧情推进草稿(相关方发布、NPC 提及或邀请<span v-pre>{{user}}</span>参与等契机);不会自动发送,也不会修改记忆。输入框已有内容时会追加在末尾。
      </ConfirmDialog>
    </div>
  </section>
</template>

<style scoped>
/* 任务页:样式为势力页同款复刻(scoped 不继承,重声明) */
.bbs-page {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.bbs-quests-wrap {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
}
/* —— 页内总开关:与设置页「任务」开关同一数据,方便不玩任务时一键关 —— */
.bbs-quest-switch {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  margin: 2px 0 10px;
  border: 1px dashed var(--bbs-line);
  border-radius: var(--bbs-radius);
  cursor: pointer;
}
.bbs-quest-switch .bbs-checkbox {
  flex: 0 0 auto;
  margin-top: 2px;
}
.bbs-quest-switch span {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--bbs-ink);
}
.bbs-quest-switch em {
  font-style: normal;
  font-weight: 400;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--bbs-ink-muted);
}
.bbs-npc-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}
.bbs-npc-group:first-of-type {
  margin-top: 4px;
}
.bbs-npc-grouphead {
  display: flex;
  align-items: center;
  gap: 10px;
}
.bbs-npc-grouphead .bbs-add-mini {
  margin-left: auto;
}
.bbs-npc-grouphead .bbs-add-mini + .bbs-add-mini {
  margin-left: 0;
}
.bbs-import-hint {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--bbs-ink-muted);
}
/* —— 折叠头:与势力页同款——左箭头 + 纯文字标题 + 金色计数药丸 —— */
.bbs-fold-head {
  flex: 0 0 auto;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.bbs-faction-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--bbs-ink);
}
.bbs-fold-caret {
  flex: 0 0 auto;
  color: var(--bbs-ink-muted);
  transition: transform 0.2s ease, color 0.15s;
}
.bbs-fold-caret.is-collapsed {
  transform: rotate(-90deg);
}
.bbs-fold-head:hover .bbs-fold-caret,
.bbs-fold-head:focus-visible .bbs-fold-caret {
  color: var(--bbs-accent);
}
.bbs-fold-count {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
  border: 1px solid var(--bbs-accent);
  border-radius: var(--bbs-radius-pill);
  padding: 1px 9px;
  font-variant-numeric: tabular-nums;
}

/* —— 整本大纲导入:页顶一张安静的入口卡 —— */
.bbs-quest-outline {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  margin: 2px 0 10px;
  border: 1px dashed var(--bbs-line);
  border-radius: var(--bbs-radius);
}
.bbs-quest-outline-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.bbs-quest-outline-head .bbs-outline-btn {
  margin-left: auto;
}
.bbs-quest-outline-hint {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--bbs-ink-muted);
}
/* 解析预览 */
.bbs-outline-preview {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bbs-outline-sum {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--bbs-ink-muted);
}
.bbs-outline-list {
  margin: 0;
  padding: 8px 10px;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface-2);
}
.bbs-outline-list li {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--bbs-ink);
}
.bbs-outline-list li.is-child {
  padding-left: 14px;
  color: var(--bbs-ink-soft);
}
.bbs-outline-kind {
  flex: 0 0 auto;
  font-size: 10.5px;
  font-weight: 600;
  padding: 0 6px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface);
  color: var(--bbs-ink-muted);
}
.bbs-outline-kind.main {
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
}
.bbs-outline-name {
  min-width: 0;
  word-break: break-word;
}
.bbs-outline-parent {
  flex: 0 0 auto;
  font-style: normal;
  font-size: 11px;
  color: var(--bbs-ink-muted);
}

.bbs-npc-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 任务卡:同势力卡安静卡片,左缘一道青瓷色条;支线用淡色条区分 */
.bbs-npc {
  position: relative;
  display: flex;
  padding: 10px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
  overflow: hidden;
}
.bbs-npc.is-present::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--bbs-accent);
  opacity: 0.5;
}
.bbs-npc.is-side::before {
  opacity: 0.28;
}
/* 子任务:左色条更细更淡,与缩进一起表达层级(与势力页同款) */
.bbs-npc.is-child::before {
  width: 2px;
  opacity: 0.28;
}
/* —— 子任务树(与势力/场景页同构):行容器 flex,轨道槽在卡片外侧,槽内一条 hairline 竖线;
      列表行距 8px,竖线上下各探出 8px 跨过行间隙连成贯穿线 —— */
.bbs-quest-row {
  display: flex;
  align-items: stretch;
}
.bbs-quest-row .bbs-npc {
  flex: 1 1 auto;
  min-width: 0;
}
.bbs-quest-rail {
  flex: 0 0 14px;
  position: relative;
}
.bbs-quest-rail::before {
  content: '';
  position: absolute;
  left: 6px;
  top: -8px;
  bottom: -8px;
  width: 1px;
  background: var(--bbs-line);
}
/* 子任务折叠箭头:与势力树同款——展开朝下,收起朝右;只有挂了子任务的卡片才出现 */
.bbs-quest-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--bbs-ink-muted);
  font-size: 13px;
  cursor: pointer;
  transition: transform 0.16s var(--bbs-ease), color var(--bbs-dur) var(--bbs-ease);
}
.bbs-quest-toggle:hover {
  color: var(--bbs-accent);
}
.bbs-quest-toggle.collapsed {
  transform: rotate(-90deg);
}
/* 收起态的子任务计数:小胶囊跟在名字后 */
.bbs-quest-childcount {
  flex: 0 0 auto;
  font-size: 11px;
  font-family: var(--bbs-font-mono);
  color: var(--bbs-ink-muted);
  padding: 0 6px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface-2);
}
.bbs-npc-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bbs-npc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 行宽不够时操作钮整体换行,而不是被卡片 overflow:hidden 裁掉 */
  flex-wrap: wrap;
  row-gap: 2px;
}
.bbs-npc-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--bbs-ink);
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bbs-npc-gender {
  font-size: 11px;
  color: var(--bbs-ink-muted);
  /* 可收缩省略:长括注不能吃光行宽、把名字挤到 0 宽(v1.5.4「无名牌」bug) */
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bbs-npc-acts {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}

.bbs-npc-fields {
  margin: 2px 0 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.bbs-npc-field {
  display: flex;
  align-items: baseline;
  gap: 7px;
}
.bbs-npc-field dt {
  flex: 0 0 auto;
  width: 30px;
  text-align: center;
  padding: 1px 0;
  border-radius: var(--bbs-radius-sm);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.5;
  letter-spacing: 0.04em;
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
}
.bbs-npc-field dd {
  margin: 0;
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--bbs-ink-soft);
  word-break: break-word;
}
/* 目标:强调金标签——任务页最核心的一类信息 */
.bbs-npc-field.f-desc dt {
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
}
.bbs-npc-field.f-desc dd {
  color: var(--bbs-ink);
}
.bbs-npc-mainhint {
  margin: 4px 0 0;
  font-size: 12px;
  font-style: italic;
  color: var(--bbs-ink-muted);
}

/* 已完结归档:整卡弱化,只剩淡淡一笔 */
.bbs-npc.is-archived {
  opacity: 0.78;
}
.bbs-npc.is-archived::before {
  width: 2px;
  opacity: 0.2;
}
.bbs-npc.is-archived .bbs-npc-name {
  font-weight: 500;
}
.bbs-npc.is-archived.is-done::before {
  background: var(--bbs-ok, var(--bbs-accent));
}
.bbs-npc.is-archived.is-failed::before {
  background: var(--bbs-danger);
}
.bbs-quest-state {
  flex: 0 0 auto;
  font-size: 10.5px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: var(--bbs-radius-pill);
  line-height: 1.5;
}
.bbs-quest-state.done {
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
}
.bbs-quest-state.failed {
  background: var(--bbs-surface-2);
  color: var(--bbs-danger);
}

/* PC 上操作按钮默认隐藏,悬停整卡才浮现;触屏常驻 */
@media (hover: hover) {
  .bbs-npc-acts {
    opacity: 0;
    transition: opacity var(--bbs-dur) var(--bbs-ease);
  }
  .bbs-npc:hover .bbs-npc-acts,
  .bbs-npc-acts:focus-within {
    opacity: 1;
  }
}

/* 行内操作按钮:复刻 items 页(scoped 不继承,重声明同款) */
.bbs-item-act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  cursor: pointer;
  font-size: 14px;
}
.bbs-item-act:hover {
  background: var(--bbs-surface-2);
  color: var(--bbs-ink);
}
.bbs-item-del:hover {
  color: var(--bbs-danger);
}
.bbs-modal-textarea {
  resize: vertical;
}
.bbs-modal-autogrow {
  overflow: hidden;
  field-sizing: content;
}
</style>
