-- 0005 named the owner's workspace after the hosted service's address, so every copy showed it.
-- A neutral name, only where the old one is still there: a workspace someone renamed keeps its name.
UPDATE "workspaces" SET "name" = 'My workspace' WHERE "id" = 1 AND "name" = 'hello@getseopen.com';
