import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";

@Entity("organizations")
export class Organization {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", nullable: false })
  name!: string;

  @Column({ type: "varchar", nullable: true, default: null })
  email!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  phone!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  address!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  industry!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  website!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  facebook!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  linkedin!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  twitter!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
