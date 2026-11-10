<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import ModalMask from '@/components/ModalMask.vue';
import { editDeepProfile, editWorldOverview, removeDeepProfile } from '@/memory/apply';
import { derivedMeta, memory } from '@/memory/store';
import type { JingtongProfile } from '@/memory/types';
import { apiSettings } from '@/api/settings';
import { toast } from '@/st/toast';
import { ref } from 'vue';

// 镜瞳(自用二改)独立页:世界观总览 / 深度档案 / 问卷备注三块归拢展示。
// 数据都是派生数据,手动编辑写回「最新一条有效叶子」(apply.ts 同范式);无有效叶子时编辑会失败并提示。

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
        <Icon name="scenes" />
        <span>世界观总览</span>
        <span class="bbs-jt-tag">镜瞳</span>
        <button class="bbs-jt-act" type="button" title="编辑总览" @click="openOverviewEdit"><Icon name="edit" /></button>
      </div>
      <p v-if="memory.worldOverview" class="bbs-jt-text">{{ memory.worldOverview }}</p>
      <p v-else class="bbs-jt-none">尚未捕获总览。楼层正文里出现【镜瞳·世界观总览】段后自动归档于此。</p>
    </div>

    <!-- 深度档案:从楼层「镜瞳·深度档案」派生的客观基底,不受摘要重总结影响 -->
    <div class="bbs-jt-block">
      <div class="bbs-jt-head">
        <Icon name="characters" />
        <span>深度档案</span>
        <span class="bbs-jt-tag">镜瞳</span>
        <span class="bbs-jt-count" v-if="memory.deepProfiles.length">{{ memory.deepProfiles.length }}</span>
      </div>
      <p class="bbs-jt-blockhint">镜瞳拍摄的客观基底(已剔除性格/印象等易变项);按设置页间隔注入主模型,防人设漂移;可手动修正,编辑/删除写入最新摘要。</p>
      <div v-if="memory.deepProfiles.length" class="bbs-jt-list">
        <article v-for="p in memory.deepProfiles" :key="p.name" class="bbs-jt-profile">
          <div class="bbs-jt-profilehead">
            <span class="bbs-jt-name" :title="p.name">{{ p.name }}</span>
            <span class="bbs-jt-gender" :title="`捕获于第 ${p.floor + 1} 楼`">镜瞳</span>
            <span class="bbs-jt-acts">
              <button class="bbs-jt-act" type="button" title="编辑" @click="openProfileEdit(p)"><Icon name="edit" /></button>
              <button class="bbs-jt-act bbs-jt-del" type="button" title="删除" @click="profileRemoving = p"><Icon name="trash" /></button>
            </span>
          </div>
          <pre class="bbs-jt-profiletext">{{ p.text }}</pre>
        </article>
      </div>
      <p v-else class="bbs-jt-none">尚无固定档案。楼层正文里出现「镜瞳·深度档案」段后自动归档于此。</p>
    </div>

    <!-- 问卷备注:玩家开局问卷申报的事实备忘(目前只注入、不参与手动编辑) -->
    <div class="bbs-jt-block">
      <div class="bbs-jt-head">
        <Icon name="bulb" />
        <span>问卷备注</span>
        <span class="bbs-jt-tag">镜瞳</span>
      </div>
      <p class="bbs-jt-blockhint">玩家开局问卷里申报的事实备忘,与总览同开关、同间隔注入。此处只读展示;要修改请改开局问卷楼层后重放摘要。</p>
      <p v-if="memory.questionnaireNotes" class="bbs-jt-text">{{ memory.questionnaireNotes }}</p>
      <p v-else class="bbs-jt-none">暂无问卷备注。</p>
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
