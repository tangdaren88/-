<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import BbsSelect from '@/components/BbsSelect.vue';
import ModalMask from '@/components/ModalMask.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import SummaryOnlyNotice from '@/components/SummaryOnlyNotice.vue';
import { editFaction, removeFaction, upsertFaction } from '@/memory/apply';
import { derivedMeta, memory } from '@/memory/store';
import type { MemFaction } from '@/memory/types';
import { getContext } from '@/st/context';
import { toast } from '@/st/toast';
import { computed, ref } from 'vue';

// 势力是从叶子摘要重放出的派生数据,手动操作写入「最新一条有效叶子」;无有效叶子时无处挂载。
const hasLeaf = computed(() => derivedMeta.hasLeaf);
const protagonistName = computed(() => {
  void derivedMeta.rev;
  return getContext()?.name1?.trim() || '主角';
});
const factionCount = computed(() => memory.factions.length);

/* —— 分组折叠:纯本机 UI 态,按聊天分桶存 localStorage(与角色页折叠同款) —— */
const FACTIONS_COLLAPSE_KEY = 'bbs.factions.collapsed.v1';
function chatKey(): string {
  return getContext()?.getCurrentChatId?.() || '_';
}
const factionsCollapsed = ref(((): boolean => {
  try {
    const all = JSON.parse(localStorage.getItem(FACTIONS_COLLAPSE_KEY) || '{}');
    return all[chatKey()] === true;
  } catch {
    return false;
  }
})());
function toggleFactionsCollapse() {
  factionsCollapsed.value = !factionsCollapsed.value;
  try {
    const all = JSON.parse(localStorage.getItem(FACTIONS_COLLAPSE_KEY) || '{}');
    all[chatKey()] = factionsCollapsed.value;
    localStorage.setItem(FACTIONS_COLLAPSE_KEY, JSON.stringify(all));
  } catch {
    /* localStorage 不可用时静默 */
  }
}

/** 扁平数组 → 树(parent 存名字;父悬空/被删视作顶级,数据不动) */
interface FactionNode extends MemFaction {
  children: FactionNode[];
}
const factionTree = computed<FactionNode[]>(() => {
  const key = (s: string): string => s.trim().toLowerCase();
  const names = new Set(memory.factions.map(f => key(f.name)));
  const byParent = new Map<string, FactionNode[]>();
  const tops: FactionNode[] = [];
  for (const f of memory.factions) {
    const node: FactionNode = { ...f, children: [] };
    const p = (f.parent ?? '').trim();
    if (p && names.has(key(p))) {
      const arr = byParent.get(key(p));
      if (arr) arr.push(node);
      else byParent.set(key(p), [node]);
    } else {
      tops.push(node);
    }
  }
  const attach = (nodes: FactionNode[]): void => {
    for (const n of nodes) {
      n.children = byParent.get(key(n.name)) ?? [];
      attach(n.children);
    }
  };
  attach(tops);
  return tops;
});
/** 展平成行(先序,带层级)供模板渲染缩进,避免递归组件;被折叠的势力其整棵子树隐藏(与场景树同款) */
const factionRows = computed(() => {
  const rows: { f: FactionNode; depth: number }[] = [];
  const walk = (nodes: FactionNode[], depth: number): void => {
    for (const n of nodes) {
      rows.push({ f: n, depth });
      const foldable = n.children.length > 0;
      if (!foldable || !collapsedNodes.value.has(n.id)) walk(n.children, depth + 1);
    }
  };
  walk(factionTree.value, 0);
  return rows;
});

/* —— 单个势力的折叠:有子势力才出现箭头,点击收起/展开其整棵子树;
      状态按聊天分桶存 localStorage(与场景树同款,默认全展开) —— */
const NODE_COLLAPSE_KEY = 'bbs.factions.collapsedNodes.v1';
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

interface FactionDraft {
  oldName: string; // 空=新增
  name: string;
  parent: string;
  desc: string;
  members: string; // 顿号/逗号分隔,保存时拆分
  userRelation: string;
}
const factionEditing = ref<FactionDraft | null>(null);
const factionRemoving = ref<MemFaction | null>(null);
/** 父势力候选:全部现有势力,排除自己;防环:自己的子孙也不可选 */
const factionParentOptions = computed(() => {
  const draft = factionEditing.value;
  const key = (s: string): string => s.trim().toLowerCase();
  const descendants = new Set<string>();
  if (draft?.oldName) {
    const collect = (name: string): void => {
      for (const f of memory.factions) {
        if (key(f.parent ?? '') === key(name) && !descendants.has(key(f.name))) {
          descendants.add(key(f.name));
          collect(f.name);
        }
      }
    };
    collect(draft.oldName);
  }
  return [
    { value: '', label: '(顶级势力)' },
    ...memory.factions
      .filter(f => f.name !== draft?.oldName && !descendants.has(key(f.name)))
      .map(f => ({ value: f.name, label: f.name })),
  ];
});
function openFactionAdd(parent?: string) {
  if (!hasLeaf.value) {
    toast('没有可写入的摘要楼层(先补摘一次)', 'error');
    return;
  }
  factionEditing.value = { oldName: '', name: '', parent: parent ?? '', desc: '', members: '', userRelation: '' };
}
function openFactionEdit(f: MemFaction) {
  factionEditing.value = {
    oldName: f.name,
    name: f.name,
    parent: f.parent ?? '',
    desc: f.desc ?? '',
    members: (f.members ?? []).join('、'),
    userRelation: f.userRelation ?? '',
  };
}
function cancelFactionEdit() {
  factionEditing.value = null;
}
function saveFactionEdit() {
  const e = factionEditing.value;
  if (!e || !e.name.trim()) return;
  const members = e.members.split(/[、,，;；/]/).map(s => s.trim()).filter(Boolean);
  const fields = { name: e.name.trim(), parent: e.parent, desc: e.desc, members, userRelation: e.userRelation };
  const ok = e.oldName ? editFaction(e.oldName, fields) : upsertFaction(fields);
  if (!ok) toast('没有可写入的摘要楼层(先补摘一次)', 'error');
  factionEditing.value = null;
}
function confirmRemoveFaction() {
  if (factionRemoving.value && !removeFaction(factionRemoving.value.name)) toast('没有可写入的摘要楼层(先补摘一次)', 'error');
  factionRemoving.value = null;
}
</script>

<template>
  <section class="bbs-page">
    <SummaryOnlyNotice />

    <div class="bbs-factions-wrap">
      <div v-if="factionCount || hasLeaf" class="bbs-npc-group">
        <div class="bbs-npc-grouphead">
          <button
            class="bbs-fold-head"
            type="button"
            :aria-expanded="!factionsCollapsed"
            :title="factionsCollapsed ? '展开势力' : '收起势力'"
            @click="toggleFactionsCollapse"
          >
            <Icon name="chevron" class="bbs-fold-caret" :class="{ 'is-collapsed': factionsCollapsed }" />
            <h2 class="bbs-faction-title">势力</h2>
            <span v-if="factionCount" class="bbs-fold-count">{{ factionCount }}</span>
          </button>
          <button class="bbs-add-mini" type="button" title="添加顶级势力" @click="openFactionAdd()"><Icon name="plus" /></button>
        </div>
        <p class="bbs-npc-mainhint">权力格局:首轮世界观总览「权力与势力」自动捕捉,随剧情演化(新立/改隶/覆灭);点 + 添加顶级势力,点卡片上的 + 添加其子势力,与{{ protagonistName }}的关系挂在各势力名下。</p>
        <div v-if="!factionsCollapsed" class="bbs-npc-list">
          <template v-if="factionRows.length">
            <article
              v-for="row in factionRows"
              :key="row.f.id"
              class="bbs-npc is-present"
              :class="{ 'is-child': row.depth > 0 }"
              :style="row.depth > 0 ? { marginLeft: `${Math.min(row.depth, 4) * 18}px` } : undefined"
            >
              <div class="bbs-npc-body">
                <div class="bbs-npc-head">
                  <button
                    v-if="row.f.children.length"
                    class="bbs-faction-toggle"
                    :class="{ collapsed: collapsedNodes.has(row.f.id) }"
                    type="button"
                    :title="collapsedNodes.has(row.f.id) ? `展开 ${row.f.children.length} 个子势力` : '收起子势力'"
                    :aria-label="collapsedNodes.has(row.f.id) ? '展开子势力' : '收起子势力'"
                    @click.stop="toggleNodeCollapse(row.f.id)"
                  ><Icon name="chevron" /></button>
                  <span class="bbs-npc-name" :title="row.f.name">{{ row.f.name }}</span>
                  <span v-if="row.f.children.length && collapsedNodes.has(row.f.id)" class="bbs-faction-childcount" :title="`已收起 ${row.f.children.length} 个子势力`">{{ row.f.children.length }}</span>
                  <span v-if="row.depth > 0 && row.f.parent" class="bbs-npc-gender" :title="`子势力 · 隶属 ${row.f.parent}`">子势力</span>
                  <span class="bbs-npc-acts">
                    <button class="bbs-item-act" type="button" :title="`在 ${row.f.name} 下添加子势力`" @click="openFactionAdd(row.f.name)"><Icon name="plus" /></button>
                    <button class="bbs-item-act" type="button" title="编辑" @click="openFactionEdit(row.f)"><Icon name="edit" /></button>
                    <button class="bbs-item-act bbs-item-del" type="button" title="删除" @click="factionRemoving = row.f"><Icon name="trash" /></button>
                  </span>
                </div>
                <dl v-if="row.f.desc || row.f.members?.length || row.f.userRelation" class="bbs-npc-fields">
                  <div v-if="row.f.desc" class="bbs-npc-field f-desc"><dt title="权柄 / 资源 / 影响范围">权力</dt><dd>{{ row.f.desc }}</dd></div>
                  <div v-if="row.f.members?.length" class="bbs-npc-field"><dt>成员</dt><dd>{{ row.f.members.join('、') }}</dd></div>
                  <div v-if="row.f.userRelation" class="bbs-npc-field f-rel"><dt>与{{ protagonistName }}</dt><dd>{{ row.f.userRelation }}</dd></div>
                </dl>
                <p v-else class="bbs-npc-mainhint">尚无描述 —— 编辑可补充权柄、成员与和主角的关系。</p>
              </div>
            </article>
          </template>
          <p v-else class="bbs-npc-mainhint">暂无势力。首轮世界观总览出现「权力与势力」后会自动捕捉;也可点上方 + 手动添加。</p>
        </div>
      </div>

      <!-- 势力 添加/编辑弹窗:名/父势力/权力描述/成员/与主角关系 -->
      <ModalMask :open="!!factionEditing" @close="cancelFactionEdit">
        <div v-if="factionEditing" class="bbs-modal" role="dialog" aria-modal="true" aria-label="编辑势力">
          <header class="bbs-modal-head">
            <span class="bbs-modal-title">{{ factionEditing.oldName ? '编辑势力' : '添加势力' }}</span>
            <button class="bbs-item-act" type="button" title="关闭" @click="cancelFactionEdit"><Icon name="close" /></button>
          </header>
          <label class="bbs-modal-field">
            <span class="bbs-modal-label">势力名</span>
            <input v-model="factionEditing.name" class="bbs-input" type="text" placeholder="如:校董会、常春藤校友会" />
          </label>
          <label class="bbs-modal-field">
            <span class="bbs-modal-label">父势力(留空 = 顶级;子势力像场景树一样挂在其下)</span>
            <BbsSelect v-model="factionEditing.parent" :options="factionParentOptions" aria-label="父势力" />
          </label>
          <label class="bbs-modal-field">
            <span class="bbs-modal-label">权力描述(权柄 / 资源 / 影响范围)</span>
            <textarea v-model="factionEditing.desc" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:掌管资源分配与招生特权"></textarea>
          </label>
          <label class="bbs-modal-field">
            <span class="bbs-modal-label">成员(已登场的关键成员,顿号或逗号分隔)</span>
            <input v-model="factionEditing.members" class="bbs-input" type="text" placeholder="如:周砚清、朱利安·凡斯" />
          </label>
          <label class="bbs-modal-field">
            <span class="bbs-modal-label">{{ protagonistName }}与该势力的当前关系</span>
            <textarea v-model="factionEditing.userRelation" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:受到校董会重点观察;与校友会素无往来"></textarea>
          </label>
          <footer class="bbs-modal-foot">
            <button class="bbs-btn" type="button" @click="cancelFactionEdit">取消</button>
            <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!factionEditing.name.trim()" @click="saveFactionEdit">保存</button>
          </footer>
        </div>
      </ModalMask>

      <ConfirmDialog
        :open="!!factionRemoving"
        title="删除势力"
        tone="danger"
        confirm-text="删除"
        confirm-icon="trash"
        @update:open="v => { if (!v) factionRemoving = null; }"
        @confirm="confirmRemoveFaction"
        @cancel="factionRemoving = null"
      >
        删除势力「{{ factionRemoving?.name }}」?其子势力不会被连带删除,会自动升为顶级(可再编辑改指其他父级)。删除会写入最新摘要,此后不会再被捕捉恢复。
      </ConfirmDialog>
    </div>
  </section>
</template>

<style scoped>
/* 势力页独立成页,样式为角色页同款复刻(scoped 不继承,重声明) */
.bbs-page {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.bbs-factions-wrap {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
}
.bbs-npc-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbs-npc-grouphead {
  display: flex;
  align-items: center;
  gap: 10px;
}
.bbs-npc-grouphead .bbs-add-mini {
  margin-left: auto;
}
/* —— 折叠头:与角色页生活小档案/摘要页计划悬念同款——左箭头 + 纯文字标题 + 金色计数药丸,无徽章 —— */
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

.bbs-npc-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 势力卡:同角色卡安静卡片,左缘一道青瓷色条 */
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
/* 子势力:左色条更细更淡,与缩进一起表达层级 */
.bbs-npc.is-child::before {
  width: 2px;
  opacity: 0.28;
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
  flex: 0 0 auto;
  white-space: nowrap;
}
/* 子势力折叠箭头:与场景树同款——展开朝下,收起朝右;只有挂了子势力的卡片才出现 */
.bbs-faction-toggle {
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
.bbs-faction-toggle:hover {
  color: var(--bbs-accent);
}
.bbs-faction-toggle.collapsed {
  transform: rotate(-90deg);
}
/* 收起态的子势力计数:小胶囊跟在名字后 */
.bbs-faction-childcount {
  flex: 0 0 auto;
  font-size: 11px;
  font-family: var(--bbs-font-mono);
  color: var(--bbs-ink-muted);
  padding: 0 6px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface-2);
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
/* 权力:强调金标签——势力页最核心的一类信息 */
.bbs-npc-field.f-desc dt {
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
}
.bbs-npc-field.f-desc dd {
  color: var(--bbs-ink);
}
/* 与主角的关系:强调色标签 */
.bbs-npc-field.f-rel dt {
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
}
.bbs-npc-field.f-rel dd {
  color: var(--bbs-ink);
}
.bbs-npc-mainhint {
  margin: 4px 0 0;
  font-size: 12px;
  font-style: italic;
  color: var(--bbs-ink-muted);
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
