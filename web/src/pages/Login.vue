<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import AuthCard from '@/components/AuthCard.vue'
import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { signedIn } from '@/composables/useSession'
import { messageOf, post } from '@/lib/api'

const router = useRouter()
const password = ref('')
const error = ref('')
const busy = ref(false)

async function submit() {
  busy.value = true
  error.value = ''
  try {
    await post('/login', { password: password.value })
    signedIn.value = true
    await router.push('/')
  } catch (failure) {
    error.value = messageOf(failure)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AuthCard title="Sign in" description="Enter the admin password for this server.">
    <form @submit.prevent="submit">
      <FieldGroup>
        <Field :data-invalid="!!error">
          <FieldLabel for="password">Password</FieldLabel>
          <Input id="password" v-model="password" type="password" autocomplete="current-password" autofocus required :aria-invalid="!!error" />
          <FieldError v-if="error">{{ error }}</FieldError>
        </Field>
        <Button type="submit" :disabled="busy || !password">
          <Spinner v-if="busy" />
          Sign in
        </Button>
      </FieldGroup>
    </form>
  </AuthCard>
</template>
