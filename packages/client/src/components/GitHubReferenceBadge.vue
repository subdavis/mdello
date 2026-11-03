<script setup lang="ts">
import { computed } from 'vue';
import type { GitHubLinkDetails } from '../references';
import { REFERENCE_ICONS } from '../references';
import IconGlyph from './IconGlyph.vue';

const props = defineProps<{ details: GitHubLinkDetails }>();
const ciLabel = computed(() => {
  const { ciStatus, ciChecks } = props.details;
  return ciChecks
    ? `CI ${ciStatus}: ${ciChecks.completed} of ${ciChecks.total} checks finished`
    : `CI ${ciStatus}`;
});
const reviewLabel = computed(() =>
  props.details.reviewStatus === 'approved' ? 'Review approved' : 'Review required',
);
</script>

<template>
  <a
    class="ref enriched-ref github-ref"
    :class="`is-${details.status}`"
    :href="details.url"
    target="_blank"
    rel="noreferrer"
    :title="details.url"
  >
    <img class="ref-icon" :src="REFERENCE_ICONS.git" alt="" />
    <span class="enriched-ref-key">#{{ details.number }}</span>
    <span class="enriched-ref-status" :title="details.status">{{ details.status }}</span>
    <span class="enriched-ref-label">{{ details.title }}</span>
    <span class="github-ref-indicators">
      <span
        v-if="details.ciStatus && details.ciStatus !== 'none'"
        class="github-ref-ci github-ci"
        :data-status="details.ciStatus"
        :aria-label="ciLabel"
        :title="ciLabel"
      >
        <span v-if="details.ciStatus === 'pending'" class="github-ci-icon" aria-hidden="true"></span>
        <IconGlyph
          v-else
          :name="details.ciStatus === 'passing' ? 'check' : 'close'"
          class="github-ci-icon"
          aria-hidden="true"
        />
        <span v-if="details.ciChecks" class="github-ci-count" aria-hidden="true"
          >{{ details.ciChecks.completed }}/{{ details.ciChecks.total }}</span
        >
      </span>
      <span
        v-if="details.reviewStatus"
        class="github-ci github-review"
        :data-status="details.reviewStatus"
        :aria-label="reviewLabel"
        :title="reviewLabel"
      >
        <IconGlyph
          :name="details.reviewStatus === 'approved' ? 'check' : 'clock'"
          class="github-ci-icon"
          aria-hidden="true"
        />
      </span>
    </span>
  </a>
</template>
