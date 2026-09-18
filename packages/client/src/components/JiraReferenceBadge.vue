<script setup lang="ts">
import type { JiraLinkDetails } from '../references';
import { REFERENCE_ICONS } from '../references';

defineProps<{ details: JiraLinkDetails }>();
</script>

<template>
  <a
    class="ref enriched-ref jira-ref"
    :href="details.url"
    target="_blank"
    rel="noreferrer"
    :title="details.url"
  >
    <img class="ref-icon" :src="REFERENCE_ICONS.jira" alt="" />
    <span>{{ details.key }}</span>
    <span class="enriched-ref-status">{{ details.status }}</span>
    <span class="enriched-ref-label">{{ details.title }}</span>
  </a>
</template>
