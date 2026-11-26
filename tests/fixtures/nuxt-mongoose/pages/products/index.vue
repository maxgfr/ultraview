<script setup lang="ts">
const { data: products, refresh } = await useFetch("/api/products");

async function create(name: string) {
  await $fetch("/api/products", { method: "POST", body: { name } });
  // await $fetch('/api/ghost', { method: 'DELETE' })
  await refresh();
}
</script>

<template>
  <ul>
    <li v-for="p in products" :key="p._id">{{ p.name }}</li>
  </ul>
  <button @click="create('New')">Add</button>
</template>
