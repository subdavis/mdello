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
    <span class="github-ref-label">#{{ details.number }} {{ details.title }}</span>
    <span class="github-ref-status">{{ details.status }}</span>
    <span
      v-if="details.ciStatus"
      class="github-ref-ci github-ci"
      :data-status="details.ciStatus"
    >
      CI {{ details.ciStatus }}
    </span>
  </a>
</template>
