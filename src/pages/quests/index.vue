<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import BbsSelect from '@/components/BbsSelect.vue';
import ModalMask from '@/components/ModalMask.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import SummaryOnlyNotice from '@/components/SummaryOnlyNotice.vue';
import { editQuest, removeQuest, upsertQuest } from '@/memory/apply';
import { apiSettings } from '@/api/settings';
import { derivedMeta, memory } from '@/memory/store';
import type { MemQuest, QuestStatus } from '@/memory/types';
import { getContext } from '@/st/context';
import { toast } from '@/st/toast';
import { computed, ref } from 'vue';

// 任务是从叶子摘要重放出的派生数据,手动操作写入「最新一条有效叶子」;无有效叶子时无处挂载。
const hasLeaf = computed(() => derivedMeta.hasLeaf);

/* —— 进行中任务:主线在前(各按创建时间),已完结归档按最近更新倒序 —— */
const activeQuests = computed(() => memory.quests.filter(q => q.status === 'active'));
const mainQuests = computed(() =>
  activeQuests.value.filter(q => q.kind === 'main').sort((a, b) => a.createdAt - b.createdAt),
);
const sideQuests = computed(() =>
  activeQuests.value.filter(q => q.kind === 'side').sort((a, b) => a.createdAt - b.createdAt),
);
const archivedQuests = computed(() =>
  memory.quests
    .filter(q => q.status !== 'active')
    .sort((a, b) => b.updatedAt - a.updatedAt),
);

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

function openQuestAdd(kind: 'main' | 'side' = 'main') {
  if (!hasLeaf.value) {
    toast('没有可写入的摘要楼层(先补摘一次)', 'error');
    return;
  }
  questEditing.value = { oldName: '', name: '', kind, desc: '', progress: '', status: 'active', faction: '' };
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
</script>

<template>
  <section class="bbs-page">
    <SummaryOnlyNotice />

    <div class="bbs-quests-wrap">
      <div v-if="memory.quests.length || hasLeaf">
        <label class="bbs-quest-switch" title="任务系统总开关(与设置页「任务」开关同步)">
          <input v-model="apiSettings.injection.quests" type="checkbox" class="bbs-checkbox" />
          <span>
            自动捕捉任务
            <em>开启:随剧情摘要自动回报任务并注入主模型防目标线写丢。关闭:不再注入、摘要也不再捕捉任务(已有记录保留,重新打开即恢复);仍可手动增删改回看。</em>
          </span>
        </label>
        <p class="bbs-npc-mainhint">主线推动剧情的核心目标,支线是可接可不做的委托;随剧情自动捕捉演化,完成/失败后移入下方「已完结」归档(不再注入)。点 + 手动添加。</p>

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
              <span v-if="mainQuests.length" class="bbs-fold-count">{{ mainQuests.length }}</span>
            </button>
            <button class="bbs-add-mini" type="button" title="批量导入主线任务" @click="openQuestImport('main')"><Icon name="download" /></button>
            <button class="bbs-add-mini" type="button" title="添加主线任务" @click="openQuestAdd('main')"><Icon name="plus" /></button>
          </div>
          <div v-if="!collapsed.main" class="bbs-npc-list">
            <template v-if="mainQuests.length">
              <article v-for="q in mainQuests" :key="q.id" class="bbs-npc is-present">
                <div class="bbs-npc-body">
                  <div class="bbs-npc-head">
                    <span class="bbs-npc-name" :title="q.name">{{ q.name }}</span>
                    <span class="bbs-npc-acts">
                      <button class="bbs-item-act" type="button" title="编辑" @click="openQuestEdit(q)"><Icon name="edit" /></button>
                      <button class="bbs-item-act bbs-item-del" type="button" title="删除" @click="questRemoving = q"><Icon name="trash" /></button>
                    </span>
                  </div>
                  <dl v-if="q.desc || q.progress || q.faction" class="bbs-npc-fields">
                    <div v-if="q.desc" class="bbs-npc-field f-desc"><dt title="做什么 / 为什么 / 做到什么程度算成">目标</dt><dd>{{ q.desc }}</dd></div>
                    <div v-if="q.progress" class="bbs-npc-field"><dt>进展</dt><dd>{{ q.progress }}</dd></div>
                    <div v-if="q.faction" class="bbs-npc-field"><dt>势力</dt><dd>{{ q.faction }}</dd></div>
                  </dl>
                  <p v-else class="bbs-npc-mainhint">尚无描述 —— 编辑可补充目标与当前进展。</p>
                </div>
              </article>
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
              <span v-if="sideQuests.length" class="bbs-fold-count">{{ sideQuests.length }}</span>
            </button>
            <button class="bbs-add-mini" type="button" title="批量导入支线任务" @click="openQuestImport('side')"><Icon name="download" /></button>
            <button class="bbs-add-mini" type="button" title="添加支线任务" @click="openQuestAdd('side')"><Icon name="plus" /></button>
          </div>
          <div v-if="!collapsed.side" class="bbs-npc-list">
            <template v-if="sideQuests.length">
              <article v-for="q in sideQuests" :key="q.id" class="bbs-npc is-present is-side">
                <div class="bbs-npc-body">
                  <div class="bbs-npc-head">
                    <span class="bbs-npc-name" :title="q.name">{{ q.name }}</span>
                    <span class="bbs-npc-acts">
                      <button class="bbs-item-act" type="button" title="编辑" @click="openQuestEdit(q)"><Icon name="edit" /></button>
                      <button class="bbs-item-act bbs-item-del" type="button" title="删除" @click="questRemoving = q"><Icon name="trash" /></button>
                    </span>
                  </div>
                  <dl v-if="q.desc || q.progress || q.faction" class="bbs-npc-fields">
                    <div v-if="q.desc" class="bbs-npc-field f-desc"><dt title="做什么 / 为什么 / 做到什么程度算成">目标</dt><dd>{{ q.desc }}</dd></div>
                    <div v-if="q.progress" class="bbs-npc-field"><dt>进展</dt><dd>{{ q.progress }}</dd></div>
                    <div v-if="q.faction" class="bbs-npc-field"><dt>势力</dt><dd>{{ q.faction }}</dd></div>
                  </dl>
                  <p v-else class="bbs-npc-mainhint">尚无描述 —— 编辑可补充目标与当前进展。</p>
                </div>
              </article>
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
        删除任务「{{ questRemoving?.name }}」?删除会写入最新摘要,此后不会再被捕捉恢复。若只是不想再跟踪,建议改成「已完成/已失败」归档保留。
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
