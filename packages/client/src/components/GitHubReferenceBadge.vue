<script setup lang="ts">
import { computed } from 'vue';
import type { GitHubLinkDetails } from '../references';
import { REFERENCE_ICONS } from '../references';

const props = defineProps<{ details: GitHubLinkDetails }>();
const ciLabel = computed(() => {
  const { ciStatus, ciChecks } = props.details;
  return ciChecks
    ? `CI ${ciStatus}: ${ciChecks.completed} of ${ciChecks.total} checks finished`
    : `CI ${ciStatus}`;
});
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
    <span
      v-if="details.ciStatus && details.ciStatus !== 'none'"
      class="github-ref-ci github-ci"
      :data-status="details.ciStatus"
      :aria-label="ciLabel"
      :title="ciLabel"
    >
      <span class="github-ci-icon" aria-hidden="true"></span>
      <span v-if="details.ciChecks" class="github-ci-count" aria-hidden="true"
        >{{ details.ciChecks.completed }}/{{ details.ciChecks.total }}</span
      >
    </span>
  </a>
</template>
