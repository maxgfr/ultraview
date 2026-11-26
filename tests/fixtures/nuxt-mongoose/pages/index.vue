<script setup lang="ts">
const { data: featured } = await useFetch("/api/products", { query: { featured: true } });
</script>

<template>
  <!-- $fetch('/api/in-a-template-comment') -->
  <main>
    <p>Don't miss our featured products: {{ featured?.length }}</p>
  </main>
</template>
