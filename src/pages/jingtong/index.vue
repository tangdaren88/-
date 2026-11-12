<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import ModalMask from '@/components/ModalMask.vue';
import { editDeepProfile, editQuestionnaireNotes, editWorldOverview, removeDeepProfile } from '@/memory/apply';
import { derivedMeta, memory } from '@/memory/store';
import type { JingtongProfile } from '@/memory/types';
import { apiSettings } from '@/api/settings';
import { getContext } from '@/st/context';
import { toast } from '@/st/toast';
import { computed, ref } from 'vue';

// 镜瞳(自用二改)独立页:世界观总览 / 深度档案 / 问卷备注三块归拢展示。
// 数据都是派生数据,手动编辑写回「最新一条有效叶子」(apply.ts 同范式);无有效叶子时编辑会失败并提示。

/* —— 折叠:整块 + 单个档案。纯本机 UI 态,按聊天分桶存 localStorage(与场景/势力页同款) —— */
type JtSection = 'overview' | 'profiles' | 'notes';
const SECTION_KEY = 'bbs.jingtong.collapsed.v1';
const PROFILE_KEY = 'bbs.jingtong.collapsedProfiles.v1';
function chatKey(): string {
  return getContext()?.getCurrentChatId?.() || '_';
}
function loadSet(key: string): Set<string> {
  try {
    const all = JSON.parse(localStorage.getItem(key) || '{}');
    const arr = all[chatKey()];
    return new Set<string>(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set<string>();
  }
}
function persistSet(key: string, set: Set<string>) {
  try {
    const all = JSON.parse(localStorage.getItem(key) || '{}');
    all[chatKey()] = [...set];
    localStorage.setItem(key, JSON.stringify(all));
  } catch {
    /* localStorage 不可用时仅本次会话生效 */
  }
}

const collapsedSections = ref<Set<string>>(loadSet(SECTION_KEY));
function isSectionCollapsed(id: JtSection): boolean {
  return collapsedSections.value.has(id);
}
function toggleSection(id: JtSection) {
  const next = new Set(collapsedSections.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsedSections.value = next; // 换引用触发响应式
  persistSet(SECTION_KEY, next);
}

// 单个档案按名字(规范化)记折叠;名字改了就等于新档案,自然回到展开态
const pkey = (name: string): string => name.trim().toLowerCase();
const collapsedProfiles = ref<Set<string>>(loadSet(PROFILE_KEY));
function isProfileCollapsed(name: string): boolean {
  return collapsedProfiles.value.has(pkey(name));
}
function toggleProfile(name: string) {
  const next = new Set(collapsedProfiles.value);
  if (next.has(pkey(name))) next.delete(pkey(name));
  else next.add(pkey(name));
  collapsedProfiles.value = next;
  persistSet(PROFILE_KEY, next);
}
const allProfilesCollapsed = computed(
  () => memory.deepProfiles.length > 0 && memory.deepProfiles.every(p => isProfileCollapsed(p.name)),
);
function toggleAllProfiles() {
  const next = new Set(collapsedProfiles.value);
  if (allProfilesCollapsed.value) {
    for (const p of memory.deepProfiles) next.delete(pkey(p.name));
  } else {
    for (const p of memory.deepProfiles) next.add(pkey(p.name));
  }
  collapsedProfiles.value = next;
  persistSet(PROFILE_KEY, next);
}
/** 收起后给个行数提示,知道这条档案有多长 */
function profileLines(p: JingtongProfile): number {
  return p.text.split('\n').filter(l => l.trim()).length;
}

/* —— 世界观总览:手动编辑(覆盖层,写回最新叶子;清空保存=还原楼层原文) —— */
const overviewEditing = ref(false);
const overviewDraft = ref('');
function openOverviewEdit() {
  overviewDraft.value = memory.worldOverview;
  overviewEditing.value = true;
}
function cancelOverviewEdit() {
  overviewEditing.value = false;
}
function saveOverviewEdit() {
  if (!editWorldOverview(overviewDraft.value)) {
    toast('无法写入总览,请确认当前聊天已有有效摘要。', 'error');
    return;
  }
  overviewEditing.value = false;
  toast(overviewDraft.value.trim() ? '总览已更新' : '已还原为楼层原文', 'success');
}

/* —— 问卷备注:手动补写(覆盖层,写回最新叶子;清空保存=还原楼层原文) ——
   备注靠扫描开局问卷楼,格式一乱就拍不到,所以这里必须有手填入口。 */
const notesEditing = ref(false);
const notesDraft = ref('');
function openNotesEdit() {
  notesDraft.value = memory.questionnaireNotes;
  notesEditing.value = true;
}
function cancelNotesEdit() {
  notesEditing.value = false;
}
function saveNotesEdit() {
  if (!editQuestionnaireNotes(notesDraft.value)) {
    toast('无法写入问卷备注,请确认当前聊天已有有效摘要。', 'error');
    return;
  }
  notesEditing.value = false;
  toast(notesDraft.value.trim() ? '问卷备注已更新' : '已还原为楼层原文', 'success');
}

/* —— 深度档案:编辑/删除(派生数据的编辑层,写回最新叶子) —— */
const profileEditing = ref<{ oldName: string; name: string; text: string } | null>(null);
const profileRemoving = ref<JingtongProfile | null>(null);
function openProfileEdit(p: JingtongProfile) {
  profileEditing.value = { oldName: p.name, name: p.name, text: p.text };
}
function cancelProfileEdit() {
  profileEditing.value = null;
}
function saveProfileEdit() {
  const e = profileEditing.value;
  if (!e || !e.name.trim()) return;
  if (!editDeepProfile(e.oldName, { name: e.name, text: e.text })) toast('没有可写入的摘要楼层(先补摘一次)', 'error');
  profileEditing.value = null;
}
function confirmRemoveProfile() {
  if (profileRemoving.value && !removeDeepProfile(profileRemoving.value.name)) toast('没有可写入的摘要楼层(先补摘一次)', 'error');
  profileRemoving.value = null;
}
</script>

<template>
  <section class="bbs-page">
    <div class="bbs-section-head">
      <h2 class="bbs-title bbs-title-sub">镜瞳</h2>
    </div>
    <SummaryOnlyNotice subject="镜瞳内容" />
    <p class="bbs-jt-hint">
      镜瞳从楼层正文里拍摄世界与角色的客观基底,注入主模型防设定漂移。注入设置在设置页「注入设置」区:
      总览 / 深度档案 / 问卷备注三者共用「镜瞳注入间隔」(当前 {{ apiSettings.deepProfileInterval }} 轮,开头两轮始终注入)。
    </p>

    <!-- 世界观总览:从楼层【镜瞳·世界观总览】/<jt_anchor> 总览段派生;可手动修正;清空保存=还原楼层原文 -->
    <div class="bbs-jt-block">
      <div class="bbs-jt-head">
        <button
          class="bbs-jt-fold"
          type="button"
          :aria-expanded="!isSectionCollapsed('overview')"
          :title="isSectionCollapsed('overview') ? '展开世界观总览' : '收起世界观总览'"
          @click="toggleSection('overview')"
        >
          <Icon name="chevron" class="bbs-jt-caret" :class="{ 'is-collapsed': isSectionCollapsed('overview') }" />
          <Icon name="scenes" />
          <span>世界观总览</span>
        </button>
        <span class="bbs-jt-tag">镜瞳</span>
        <button class="bbs-jt-act" type="button" title="编辑总览" @click="openOverviewEdit"><Icon name="edit" /></button>
      </div>
      <template v-if="!isSectionCollapsed('overview')">
        <p v-if="memory.worldOverview" class="bbs-jt-text">{{ memory.worldOverview }}</p>
        <p v-else class="bbs-jt-none">尚未捕获总览。楼层正文里出现【镜瞳·世界观总览】段后自动归档于此。</p>
      </template>
    </div>

    <!-- 深度档案:从楼层「镜瞳·深度档案」派生的客观基底,不受摘要重总结影响 -->
    <div class="bbs-jt-block">
      <div class="bbs-jt-head">
        <button
          class="bbs-jt-fold"
          type="button"
          :aria-expanded="!isSectionCollapsed('profiles')"
          :title="isSectionCollapsed('profiles') ? '展开深度档案' : '收起深度档案'"
          @click="toggleSection('profiles')"
        >
          <Icon name="chevron" class="bbs-jt-caret" :class="{ 'is-collapsed': isSectionCollapsed('profiles') }" />
          <Icon name="characters" />
          <span>深度档案</span>
        </button>
        <span class="bbs-jt-tag">镜瞳</span>
        <span class="bbs-jt-count" v-if="memory.deepProfiles.length">{{ memory.deepProfiles.length }}</span>
        <button
          v-if="memory.deepProfiles.length && !isSectionCollapsed('profiles')"
          class="bbs-jt-textbtn"
          type="button"
          :title="allProfilesCollapsed ? '展开全部档案' : '收起全部档案'"
          @click="toggleAllProfiles"
        >{{ allProfilesCollapsed ? '全部展开' : '全部收起' }}</button>
      </div>
      <template v-if="!isSectionCollapsed('profiles')">
        <p class="bbs-jt-blockhint">镜瞳拍摄的客观基底(已剔除性格/印象等易变项);按设置页间隔注入主模型,防人设漂移;可手动修正,编辑/删除写入最新摘要。</p>
        <div v-if="memory.deepProfiles.length" class="bbs-jt-list">
          <article v-for="p in memory.deepProfiles" :key="p.name" class="bbs-jt-profile">
            <div class="bbs-jt-profilehead">
              <button
                class="bbs-jt-nametoggle"
                type="button"
                :aria-expanded="!isProfileCollapsed(p.name)"
                :title="isProfileCollapsed(p.name) ? '展开这条档案' : '收起这条档案'"
                @click="toggleProfile(p.name)"
              >
                <Icon name="chevron" class="bbs-jt-caret" :class="{ 'is-collapsed': isProfileCollapsed(p.name) }" />
                <span class="bbs-jt-name" :title="p.name">{{ p.name }}</span>
              </button>
              <span class="bbs-jt-gender" :title="`捕获于第 ${p.floor + 1} 楼`">镜瞳</span>
              <span v-if="isProfileCollapsed(p.name)" class="bbs-jt-count">{{ profileLines(p) }} 行</span>
              <span class="bbs-jt-acts">
                <button class="bbs-jt-act" type="button" title="编辑" @click="openProfileEdit(p)"><Icon name="edit" /></button>
                <button class="bbs-jt-act bbs-jt-del" type="button" title="删除" @click="profileRemoving = p"><Icon name="trash" /></button>
              </span>
            </div>
            <pre v-if="!isProfileCollapsed(p.name)" class="bbs-jt-profiletext">{{ p.text }}</pre>
          </article>
        </div>
        <p v-else class="bbs-jt-none">尚无固定档案。楼层正文里出现「镜瞳·深度档案」段后自动归档于此。</p>
      </template>
    </div>

    <!-- 问卷备注:玩家开局问卷申报的事实备忘(目前只注入、不参与手动编辑) -->
    <div class="bbs-jt-block">
      <div class="bbs-jt-head">
        <button
          class="bbs-jt-fold"
          type="button"
          :aria-expanded="!isSectionCollapsed('notes')"
          :title="isSectionCollapsed('notes') ? '展开问卷备注' : '收起问卷备注'"
          @click="toggleSection('notes')"
        >
          <Icon name="chevron" class="bbs-jt-caret" :class="{ 'is-collapsed': isSectionCollapsed('notes') }" />
          <Icon name="bulb" />
          <span>问卷备注</span>
        </button>
        <span class="bbs-jt-tag">镜瞳</span>
        <button class="bbs-jt-act" type="button" title="编辑问卷备注" @click="openNotesEdit"><Icon name="edit" /></button>
      </div>
      <template v-if="!isSectionCollapsed('notes')">
        <p class="bbs-jt-blockhint">玩家开局问卷里申报的事实备忘,与总览同开关、同间隔注入。捕捉不到或想补写时点右上角编辑;清空保存=还原楼层原文。</p>
        <p v-if="memory.questionnaireNotes" class="bbs-jt-text">{{ memory.questionnaireNotes }}</p>
        <p v-else class="bbs-jt-none">暂无问卷备注。</p>
      </template>
    </div>

    <!-- 世界观总览编辑弹窗 -->
    <ModalMask :open="overviewEditing" @close="cancelOverviewEdit">
      <div v-if="overviewEditing" class="bbs-modal" role="dialog" aria-modal="true" aria-label="编辑世界观总览">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">编辑世界观总览</span>
          <button class="bbs-jt-act" type="button" title="关闭" @click="cancelOverviewEdit"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">总览正文(楼层原文不变,这里的修改是覆盖层;清空保存=还原楼层原文)</span>
          <textarea v-model="overviewDraft" class="bbs-input bbs-jt-textarea" rows="10" placeholder="世界基底设定,每行一条"></textarea>
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelOverviewEdit">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="saveOverviewEdit">保存</button>
        </footer>
      </div>
    </ModalMask>

    <!-- 问卷备注编辑弹窗:覆盖层,楼层原文不变;清空保存=还原楼层原文 -->
    <ModalMask :open="notesEditing" @close="cancelNotesEdit">
      <div v-if="notesEditing" class="bbs-modal" role="dialog" aria-modal="true" aria-label="编辑问卷备注">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">编辑问卷备注</span>
          <button class="bbs-jt-act" type="button" title="关闭" @click="cancelNotesEdit"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">备注正文(人物小传 / 世界设定等既定事实;清空保存=还原楼层原文)</span>
          <textarea v-model="notesDraft" class="bbs-input bbs-jt-textarea" rows="10"></textarea>
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelNotesEdit">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="saveNotesEdit">保存</button>
        </footer>
      </div>
    </ModalMask>

    <!-- 深度档案编辑弹窗:改名/改文,按原名写回最新摘要,重放时套用在楼层拍摄结果上 -->
    <ModalMask :open="!!profileEditing" @close="cancelProfileEdit">
      <div v-if="profileEditing" class="bbs-modal" role="dialog" aria-modal="true" aria-label="编辑固定档案">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">编辑固定档案</span>
          <button class="bbs-jt-act" type="button" title="关闭" @click="cancelProfileEdit"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">名字</span>
          <input v-model="profileEditing.name" class="bbs-input" type="text" placeholder="角色名" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">档案正文(客观固定设定;楼层原文不变,这里的修改会覆盖拍摄结果并长期生效)</span>
          <textarea v-model="profileEditing.text" class="bbs-input bbs-jt-textarea" rows="8" placeholder="每行一条,如:姓名：周砚清"></textarea>
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelProfileEdit">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!profileEditing.name.trim()" @click="saveProfileEdit">保存</button>
        </footer>
      </div>
    </ModalMask>

    <ConfirmDialog
      :open="!!profileRemoving"
      title="删除固定档案"
      tone="danger"
      confirm-text="删除"
      confirm-icon="trash"
      @update:open="v => { if (!v) profileRemoving = null; }"
      @confirm="confirmRemoveProfile"
      @cancel="profileRemoving = null"
    >
      删除「{{ profileRemoving?.name }}」的镜瞳固定档案。此后楼层再拍到同名档案也不会恢复(可重新拍摄覆盖)。
    </ConfirmDialog>
  </section>
</template>

<style scoped>
/* 页顶说明:注入间隔与开关口径 */
.bbs-jt-hint {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--bbs-ink-soft);
}

/* 通用块卡(借场景页总览卡同款骨架,scoped 不继承,这里重声明) */
.bbs-jt-block {
  margin: 10px 0 2px;
  padding: 9px 12px;
  border: 1px solid var(--bbs-line);
  border-left: 3px solid var(--bbs-accent);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
}
.bbs-jt-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--bbs-font-mono);
  font-size: 13px;
  font-weight: 600;
  color: var(--bbs-ink);
}
/* 区块折叠头:整块标题都可点,箭头展开朝下/收起朝右(与场景、势力、任务页同款) */
.bbs-jt-fold {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.bbs-jt-fold:hover .bbs-jt-caret,
.bbs-jt-fold:focus-visible .bbs-jt-caret {
  color: var(--bbs-accent);
}
.bbs-jt-caret {
  flex: 0 0 auto;
  color: var(--bbs-ink-muted);
  transition: transform 0.2s ease, color 0.15s;
}
.bbs-jt-caret.is-collapsed {
  transform: rotate(-90deg);
}
/* 档案列表的「全部收起/展开」:安静的小文字按钮 */
.bbs-jt-textbtn {
  flex: 0 0 auto;
  margin-left: 4px;
  padding: 2px 6px;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  font-family: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.bbs-jt-textbtn:hover {
  background: var(--bbs-surface-2);
  color: var(--bbs-accent);
}
.bbs-jt-tag {
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 400;
  padding: 0 6px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
}
.bbs-jt-count {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 400;
  color: var(--bbs-ink-muted);
}
.bbs-jt-blockhint {
  margin: 4px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--bbs-ink-muted);
}

/* 正文展示:pre-wrap 保留换行 */
.bbs-jt-text {
  margin: 6px 0 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--bbs-ink-soft);
  white-space: pre-wrap;
  word-break: break-word;
}
.bbs-jt-none {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--bbs-ink-muted);
}

/* 行内操作按钮(items 页同款重声明) */
.bbs-jt-act {
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
  margin-left: auto;
  flex: 0 0 auto;
}
.bbs-jt-head .bbs-jt-act:hover {
  background: var(--bbs-surface-2);
  color: var(--bbs-ink);
}
.bbs-jt-del:hover {
  color: var(--bbs-danger);
}

/* 深度档案列表 */
.bbs-jt-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}
.bbs-jt-profile {
  padding: 8px 10px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface-2);
}
.bbs-jt-profilehead {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
/* 单条档案的名字也是折叠按钮:手机上好点,不用瞄小箭头 */
.bbs-jt-nametoggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.bbs-jt-nametoggle:hover .bbs-jt-caret,
.bbs-jt-nametoggle:focus-visible .bbs-jt-caret {
  color: var(--bbs-accent);
}
.bbs-jt-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  font-size: 13px;
  color: var(--bbs-ink);
}
.bbs-jt-gender {
  flex: 0 0 auto;
  font-size: 10px;
  padding: 0 6px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
}
/* PC(支持 hover)上操作按钮默认隐藏,悬停整卡才浮现;触屏常驻 */
@media (hover: hover) {
  .bbs-jt-acts .bbs-jt-act {
    opacity: 0;
    transition: opacity 0.16s ease;
  }
  .bbs-jt-profile:hover .bbs-jt-act,
  .bbs-jt-acts .bbs-jt-act:focus-within {
    opacity: 1;
  }
}
.bbs-jt-acts {
  display: inline-flex;
  gap: 2px;
  margin-left: auto;
  flex: 0 0 auto;
}
.bbs-jt-acts .bbs-jt-act {
  margin-left: 0;
}
/* 档案正文:等宽小字,逐行原样展示 */
.bbs-jt-profiletext {
  margin: 6px 0 0;
  padding: 8px 10px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  line-height: 1.7;
  color: var(--bbs-ink-soft);
  white-space: pre-wrap;
  word-break: break-word;
}

.bbs-jt-textarea {
  resize: vertical;
  min-height: 60px;
  font-family: inherit;
}
</style>
