<script setup lang="ts">
const route = useRoute();
const { data: product } = await useFetch(() => `/api/products/${route.params.id}`);

async function remove() {
  await $fetch(`/api/products/${route.params.id}`, { method: "DELETE" });
  await navigateTo("/products");
}
</script>

<template>
  <article>
    <h1>{{ product?.name }}</h1>
    <button @click="remove">Delete</button>
  </article>
</template>
