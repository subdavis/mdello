<script setup lang="ts">
import type { GitHubLinkDetails } from '../references';
import { REFERENCE_ICONS } from '../references';

defineProps<{ details: GitHubLinkDetails }>();
</script>

<template>
  <a
    class="ref github-ref"
    :class="`is-${details.status}`"
    :href="details.url"
    target="_blank"
    rel="noreferrer"
    :title="details.url"
  >
    <img class="ref-icon" :src="REFERENCE_ICONS.git" alt="" />
    <span>#{{ details.number }}</span>
    <span class="github-ref-status">{{ details.status }}</span>
    <span class="github-ref-label">{{ details.title }}</span>
    <span
      v-if="details.ciStatus && details.ciStatus !== 'none'"
      class="github-ref-ci github-ci"
      :data-status="details.ciStatus"
      :aria-label="`CI ${details.ciStatus}`"
      :title="`CI ${details.ciStatus}`"
    >
      <span class="github-ci-icon" aria-hidden="true"></span>
    </span>
  </a>
</template>
